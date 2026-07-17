import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTelemetry, generateArtifacts, redact, redactSummary } from './core/index.js';
import { OAuthRequiredError, OAuthSessionManager } from './mcp/oauth-client.js';
import { createProvider } from './providers/index.js';
import { resolveDatadogMcpConfig } from './providers/datadog.js';
import { resolveLast9McpConfig } from './providers/last9.js';
import { createSignalAnalysisStore } from './signals/analysis.js';

const webRoot = fileURLToPath(new URL('../web', import.meta.url));
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(value));
  return true;
}

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    const error = new Error('API requests must use application/json.');
    error.statusCode = 415;
    throw error;
  }
  let raw = '';
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('Request body must contain valid JSON.');
  }
}

function validateTimeWindow(timeWindow) {
  if (!timeWindow?.start || !timeWindow?.end) throw new Error('A start and end time are required.');
  const start = new Date(timeWindow.start);
  const end = new Date(timeWindow.end);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end) throw new Error('Time window must contain valid start and end timestamps.');
  if (end - start > MAX_WINDOW_MS) throw new Error('Time window cannot exceed 7 days.');
  return { start: start.toISOString(), end: end.toISOString() };
}

function isControlCharacter(character) {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

function hasControlCharacters(value) {
  return [...value].some(isControlCharacter);
}

function replaceControlCharacters(value) {
  return [...value].map((character) => isControlCharacter(character) ? ' ' : character).join('');
}

function validateScopeValue(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Choose a valid ${label}.`);
  const normalized = value.trim();
  if (normalized.length > 256 || hasControlCharacters(normalized)) throw new Error(`${label} is too long or contains control characters.`);
  return normalized;
}

function hostnameFromHostHeader(host) {
  try { return new URL(`http://${host}`).hostname.toLowerCase(); } catch { return ''; }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function publicErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Request failed.';
  return replaceControlCharacters(redact(message)).trim().slice(0, 500) || 'Request failed.';
}

function publicConnection(connection) {
  const serverInfo = connection?.serverInfo || {};
  return {
    provider: connection?.provider,
    readOnly: connection?.readOnly === true,
    serverInfo: {
      name: redact(serverInfo.name || serverInfo.title || 'MCP server').slice(0, 120),
      version: serverInfo.version == null ? undefined : redact(serverInfo.version).slice(0, 80),
    },
    tools: Array.isArray(connection?.tools)
      ? connection.tools.filter((name) => typeof name === 'string').slice(0, 100).map((name) => redact(name).slice(0, 120))
      : [],
  };
}

export function createTelemetryDietServer({ env = process.env } = {}) {
  const providers = new Map();
  const analyses = new Map();
  const oauth = new OAuthSessionManager();
  const signalAnalyses = createSignalAnalysisStore({ env, oauth });
  let expectedOrigin = null;

  function validateLocalRequest(request) {
    const host = String(request.headers.host || '');
    if (!isLoopbackHostname(hostnameFromHostHeader(host))) {
      const error = new Error('Telemetry Diet accepts requests only through its loopback address.');
      error.statusCode = 403;
      throw error;
    }
    if (expectedOrigin && host.toLowerCase() !== new URL(expectedOrigin).host.toLowerCase()) {
      const error = new Error('Request Host does not match the local Telemetry Diet server.');
      error.statusCode = 403;
      throw error;
    }
    const origin = request.headers.origin;
    if (origin && (!expectedOrigin || origin !== expectedOrigin)) {
      const error = new Error('Cross-origin requests are not allowed.');
      error.statusCode = 403;
      throw error;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      const error = new Error('Cross-site requests are not allowed.');
      error.statusCode = 403;
      throw error;
    }
  }

  async function closeProvider(provider) {
    const current = providers.get(provider);
    providers.delete(provider);
    await current?.close();
  }

  async function routeApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, { ok: true, name: 'telemetry-diet', version: '0.1.0' });
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const datadog = resolveDatadogMcpConfig(env);
      const last9 = resolveLast9McpConfig(env);
      return json(response, 200, {
        providers: {
          sample: { configured: true, credentialless: true },
          datadog: { configured: datadog.configured, mode: datadog.mode },
          last9: { configured: last9.configured, mode: last9.mode, orgSlug: last9.orgSlug },
        },
        trust: { readOnly: true, productionWrites: false, aiRawLogAccess: false },
      });
    }
    const analysisMatch = request.method === 'GET' && url.pathname.match(/^\/api\/analysis\/([a-f0-9-]+)$/i);
    if (analysisMatch) {
      const signalAnalysis = signalAnalyses.get(analysisMatch[1]);
      if (signalAnalysis) return json(response, 200, signalAnalysis);
      const analysis = analyses.get(analysisMatch[1]);
      if (!analysis) return json(response, 404, { error: 'Analysis expired. Run the analysis again.' });
      return json(response, 200, {
        analysisId: analysisMatch[1],
        summary: analysis.summary,
        findings: analysis.findings,
        artifacts: generateArtifacts(analysis.summary, analysis.findings, analysis.selectedIds),
      });
    }
    if (request.method !== 'POST') return false;
    const input = await body(request);
    if (url.pathname === '/api/connect') {
      if (!['sample', 'datadog', 'last9'].includes(input.provider)) throw new Error('Choose a supported provider.');
      await closeProvider(input.provider);
      const adapter = createProvider(input.provider, env, { oauth });
      try {
        const connection = await adapter.connect();
        if (connection?.readOnly !== true) throw new Error('Provider connection did not confirm the read-only contract.');
        const services = await adapter.discoverServices();
        const environments = await adapter.getEnvironments(services[0]);
        providers.set(input.provider, adapter);
        return json(response, 200, { connection: publicConnection(connection), services, environments, warning: services.length ? undefined : `${input.provider} MCP returned no services.` });
      } catch (error) {
        if (error instanceof OAuthRequiredError) {
          return json(response, 202, {
            authorizationRequired: true,
            authorizationUrl: error.authorizationUrl,
            provider: error.provider,
          });
        }
        await adapter.close();
        throw error;
      }
    }
    if (url.pathname === '/api/environments') {
      const adapter = providers.get(input.provider);
      if (!adapter) throw new Error(`Connect ${input.provider} MCP first.`);
      return json(response, 200, { environments: await adapter.getEnvironments(validateScopeValue(input.service, 'service')) });
    }
    if (url.pathname === '/api/analyze') {
      if (!['logs', 'metrics', 'traces'].includes(input.signal || 'logs')) throw new Error('Choose a supported telemetry signal.');
      if (input.service != null) input.service = validateScopeValue(input.service, 'service');
      if (input.environment != null) input.environment = validateScopeValue(input.environment, 'environment', { optional: true });
      const signalAnalysis = await signalAnalyses.analyze(input, validateTimeWindow);
      if (signalAnalysis) return json(response, 200, signalAnalysis);
      const adapter = providers.get(input.provider);
      if (!adapter) throw new Error(`Connect ${input.provider} MCP first.`);
      if (!input.service) throw new Error('Choose a service.');
      const timeWindow = validateTimeWindow(input.timeWindow);
      const summary = redactSummary(await adapter.analyze({ service: input.service, environment: input.environment, timeWindow }));
      const findings = analyzeTelemetry(summary);
      const artifacts = generateArtifacts(summary, findings);
      const analysisId = randomUUID();
      analyses.set(analysisId, { summary, findings, selectedIds: artifacts.selectedIds });
      if (analyses.size > 20) analyses.delete(analyses.keys().next().value);
      return json(response, 200, { analysisId, summary, findings, artifacts });
    }
    if (url.pathname === '/api/generate') {
      const analysis = analyses.get(input.analysisId);
      if (!analysis) throw new Error('Analysis expired. Run the analysis again.');
      const selectedIds = Array.isArray(input.selectedIds)
        ? input.selectedIds.filter((id) => typeof id === 'string' && id.length <= 200).slice(0, 100)
        : [];
      analysis.selectedIds = selectedIds;
      return json(response, 200, { artifacts: generateArtifacts(analysis.summary, analysis.findings, selectedIds) });
    }
    return false;
  }

  async function routeOAuth(request, response, url) {
    const match = url.pathname.match(/^\/oauth\/callback\/(datadog|last9)$/);
    if (!match || request.method !== 'GET') return false;
    const provider = match[1];
    const error = url.searchParams.get('error');
    if (error) throw new Error(`${provider} login was not authorized.`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('OAuth callback did not include an authorization code.');
    await oauth.finishAuth(provider, { code, state: url.searchParams.get('state') });
    const origin = oauth.baseUrl;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Telemetry Diet connected</title><style>body{font:16px system-ui;margin:48px;color:#17211d}strong{display:block;font-size:24px;margin-bottom:8px}</style></head><body><strong>${provider === 'datadog' ? 'Datadog' : 'Last9'} connected</strong><p>You can close this window and return to Telemetry Diet.</p><script>window.opener?.postMessage({type:'telemetry-diet-oauth',provider:${JSON.stringify(provider)}},${JSON.stringify(origin)});setTimeout(()=>window.close(),600);</script></body></html>`);
    return true;
  }

  async function serveStatic(response, pathname) {
    const appRoute = pathname === '/' || pathname === '/workbench' || /^\/results\/[a-f0-9-]+$/i.test(pathname);
    const relative = appRoute ? 'index.html' : pathname.slice(1);
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(webRoot, safe);
    try {
      const details = await stat(file);
      if (!details.isFile()) return false;
      response.writeHead(200, {
        'content-type': contentTypes[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      createReadStream(file).pipe(response);
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      validateLocalRequest(request);
      if (url.pathname.startsWith('/api/')) {
        const handled = await routeApi(request, response, url);
        if (!handled) json(response, 404, { error: 'API route not found.' });
      } else if (url.pathname.startsWith('/oauth/')) {
        const handled = await routeOAuth(request, response, url);
        if (!handled) json(response, 404, { error: 'OAuth route not found.' });
      } else if (!await serveStatic(response, url.pathname)) {
        json(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      json(response, error.statusCode || 400, { error: publicErrorMessage(error) });
    }
  });

  server.setBaseUrl = (baseUrl) => {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) throw new Error('Telemetry Diet OAuth callbacks require a loopback HTTP URL.');
    expectedOrigin = parsed.origin;
    oauth.setBaseUrl(expectedOrigin);
  };
  server.closeProviders = async () => Promise.all([...providers.keys()].map(closeProvider));
  return server;
}

export async function listen(server, { host = '127.0.0.1', port = 4545 } = {}) {
  if (!isLoopbackHostname(String(host).toLowerCase())) throw new Error('Telemetry Diet only listens on localhost, 127.0.0.1, or ::1.');
  for (let candidate = port; candidate < port + 20; candidate++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(candidate, host);
      });
      const urlHost = host === '::1' ? '[::1]' : host;
      const address = { host, port: candidate, url: `http://${urlHost}:${candidate}` };
      server.setBaseUrl?.(address.url);
      return address;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available port between ${port} and ${port + 19}.`);
}
