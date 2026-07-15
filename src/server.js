import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTelemetry, generateArtifacts, redactSummary } from './core/index.js';
import { OAuthRequiredError, OAuthSessionManager } from './mcp/oauth-client.js';
import { createProvider } from './providers/index.js';
import { resolveDatadogMcpConfig } from './providers/datadog.js';
import { resolveLast9McpConfig } from './providers/last9.js';

const webRoot = fileURLToPath(new URL('../web', import.meta.url));
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
  });
  response.end(JSON.stringify(value));
  return true;
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request body is too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

function validateTimeWindow(timeWindow) {
  if (!timeWindow?.start || !timeWindow?.end) throw new Error('A start and end time are required.');
  const start = new Date(timeWindow.start);
  const end = new Date(timeWindow.end);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end) throw new Error('Time window must contain valid start and end timestamps.');
  return { start: start.toISOString(), end: end.toISOString() };
}

export function createTelemetryDietServer({ env = process.env } = {}) {
  const providers = new Map();
  const analyses = new Map();
  const oauth = new OAuthSessionManager();

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
        const services = await adapter.discoverServices();
        providers.set(input.provider, adapter);
        const environments = await adapter.getEnvironments(services[0]);
        return json(response, 200, { connection, services, environments, warning: services.length ? undefined : `${input.provider} MCP returned no services.` });
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
      return json(response, 200, { environments: await adapter.getEnvironments(input.service) });
    }
    if (url.pathname === '/api/analyze') {
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
      const selectedIds = Array.isArray(input.selectedIds) ? input.selectedIds.filter((id) => typeof id === 'string') : [];
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
    if (error) throw new Error(`${provider} login was not authorized: ${error}`);
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
      json(response, 400, { error: error.message || 'Request failed.' });
    }
  });

  server.setBaseUrl = (baseUrl) => oauth.setBaseUrl(baseUrl);
  server.closeProviders = async () => Promise.all([...providers.keys()].map(closeProvider));
  return server;
}

export async function listen(server, { host = '127.0.0.1', port = 4545 } = {}) {
  for (let candidate = port; candidate < port + 20; candidate++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(candidate, host);
      });
      return { host, port: candidate, url: `http://${host}:${candidate}` };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available port between ${port} and ${port + 19}.`);
}
