import { spawn } from 'node:child_process';

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const BASE_CHILD_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|SystemRoot|ComSpec|PATHEXT|LANG|LC_ALL|LC_CTYPE|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|npm_config_cache)$/i;

export function buildMcpChildEnvironment(source = process.env, envPrefix = '') {
  const child = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value != null && BASE_CHILD_ENV.test(key)) child[key] = String(value);
  }
  const allowlistKey = envPrefix ? `${envPrefix}_MCP_ENV_ALLOWLIST` : '';
  const allowlist = allowlistKey ? String(source?.[allowlistKey] || '').split(',').map((key) => key.trim()).filter(Boolean) : [];
  for (const key of allowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${allowlistKey} contains an invalid environment variable name.`);
    if (source[key] != null) child[key] = String(source[key]);
  }
  return child;
}

function validatedMcpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('MCP URL must be a valid HTTP or HTTPS URL.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('MCP URL must use HTTPS or loopback HTTP.');
  }
  return url.toString();
}

function parseSse(text) {
  const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  return data ? JSON.parse(data) : null;
}

function unwrapToolResult(result) {
  if (result?.isError) throw new Error('MCP tool call failed.');
  if (result?.structuredContent != null) return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

class BaseClient {
  constructor() {
    this.id = 0;
    this.serverInfo = null;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'telemetry-diet', version: '0.1.0' },
    });
    this.serverInfo = result.serverInfo;
    await this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools || [];
  }

  async callTool(name, args = {}) {
    return unwrapToolResult(await this.request('tools/call', { name, arguments: args }));
  }
}

export class StdioMcpClient extends BaseClient {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.pending = new Map();
  }

  async connect() {
    this.process = spawn(this.command, this.args, {
      cwd: this.options.cwd || process.cwd(),
      env: this.options.env || buildMcpChildEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.setEncoding('utf8');
    let buffer = '';
    this.process.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > (this.options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES)) {
          this.rejectAll(new Error('MCP stdio response exceeded the safe size limit.'));
          this.process.kill('SIGTERM');
          return;
        }
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            message.error ? pending.reject(new Error(`MCP request failed: ${pending.method}.`)) : pending.resolve(message.result);
          }
        } catch {
          this.rejectAll(new Error('MCP server returned an invalid response.'));
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > (this.options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES)) {
        this.rejectAll(new Error('MCP stdio response exceeded the safe size limit.'));
        this.process.kill('SIGTERM');
      }
    });
    this.process.stderr.on('data', () => {});
    this.process.once('error', () => this.rejectAll(new Error('MCP process could not be started.')));
    this.process.once('exit', (code) => this.rejectAll(new Error(`MCP process exited with code ${code}.`)));
    await this.initialize();
    return this;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.options.timeout || 30000);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    if (this.process && !this.process.killed) this.process.kill('SIGTERM');
  }
}

export class HttpMcpClient extends BaseClient {
  constructor(url, options = {}) {
    super();
    this.url = validatedMcpUrl(url);
    this.options = options;
    this.sessionId = null;
  }

  async connect() {
    await this.initialize();
    return this;
  }

  async send(payload) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.options.headers || {}),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const controller = new AbortController();
    const configuredTimeout = Number(this.options.timeout);
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 180000)
      : 30000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this.url, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`MCP HTTP request failed with status ${response.status}.`);
      }
      this.sessionId = response.headers.get('mcp-session-id') || this.sessionId;
      if (response.status === 202) return null;
      const maxBytes = this.options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
      const advertisedLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error('MCP HTTP response exceeded the safe size limit.');
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error('MCP HTTP response exceeded the safe size limit.');
          }
          chunks.push(value);
        }
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(combined);
      let message;
      try {
        message = response.headers.get('content-type')?.includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
      } catch {
        throw new Error('MCP server returned an invalid HTTP response.');
      }
      if (message?.error) throw new Error(`MCP request failed: ${payload.method}.`);
      return message?.result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`MCP HTTP request timed out: ${payload.method}`);
      if (typeof error?.message === 'string' && error.message.startsWith('MCP ')) throw error;
      throw new Error('MCP HTTP request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  request(method, params) {
    return this.send({ jsonrpc: '2.0', id: ++this.id, method, params });
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  async close() {}
}

export function parseCommand(command, argsJson) {
  if (!command) return null;
  if (command.trim().startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(command); } catch { throw new Error('MCP command JSON must be a non-empty array of strings.'); }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((value) => typeof value !== 'string' || !value)) {
      throw new Error('MCP command JSON must be a non-empty array of strings.');
    }
    const [executable, ...args] = parsed;
    return { executable, args };
  }
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) || [];
  let extraArgs;
  try { extraArgs = argsJson ? JSON.parse(argsJson) : []; } catch { throw new Error('MCP args JSON must be an array of strings.'); }
  if (!Array.isArray(extraArgs) || extraArgs.some((value) => typeof value !== 'string')) {
    throw new Error('MCP args JSON must be an array of strings.');
  }
  return { executable: parts[0], args: [...parts.slice(1), ...extraArgs] };
}

export async function createMcpClient(config) {
  let client;
  if (config.oauthClient) {
    client = config.oauthClient;
  } else if (config.url) {
    client = new HttpMcpClient(config.url, {
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      timeout: config.timeout,
    });
  } else {
    const parsed = parseCommand(config.command, config.args);
    if (!parsed?.executable) throw new Error(`${config.label} MCP is not configured. Set ${config.envPrefix}_MCP_URL or ${config.envPrefix}_MCP_COMMAND.`);
    client = new StdioMcpClient(parsed.executable, parsed.args, {
      env: buildMcpChildEnvironment(config.sourceEnv || process.env, config.envPrefix),
      timeout: config.timeout,
    });
  }
  try {
    return await client.connect();
  } catch (error) {
    if (error?.name !== 'OAuthRequiredError') {
      try { await client.close?.(); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}
