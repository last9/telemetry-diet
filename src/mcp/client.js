import { spawn } from 'node:child_process';

function parseSse(text) {
  const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  return data ? JSON.parse(data) : null;
}

function unwrapToolResult(result) {
  if (result?.isError) throw new Error(result.content?.map(({ text }) => text).filter(Boolean).join('\n') || 'MCP tool call failed');
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
    this.stderr = '';
  }

  async connect() {
    this.process = spawn(this.command, this.args, {
      cwd: this.options.cwd || process.cwd(),
      env: { ...process.env, ...(this.options.env || {}) },
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
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
          }
        } catch (error) {
          this.rejectAll(new Error(`Invalid MCP response: ${error.message}`));
        }
      }
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.process.once('error', (error) => this.rejectAll(error));
    this.process.once('exit', (code) => this.rejectAll(new Error(`MCP process exited with code ${code}. ${this.stderr}`)));
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
    this.url = url;
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
    const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    this.sessionId = response.headers.get('mcp-session-id') || this.sessionId;
    if (response.status === 202) return null;
    const text = await response.text();
    const message = response.headers.get('content-type')?.includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
    if (message?.error) throw new Error(message.error.message);
    return message?.result;
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
    const [executable, ...args] = JSON.parse(command);
    return { executable, args };
  }
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) || [];
  const extraArgs = argsJson ? JSON.parse(argsJson) : [];
  return { executable: parts[0], args: [...parts.slice(1), ...extraArgs] };
}

export async function createMcpClient(config) {
  let client;
  if (config.oauthClient) {
    client = config.oauthClient;
  } else if (config.url) {
    client = new HttpMcpClient(config.url, { headers: config.token ? { authorization: `Bearer ${config.token}` } : {} });
  } else {
    const parsed = parseCommand(config.command, config.args);
    if (!parsed?.executable) throw new Error(`${config.label} MCP is not configured. Set ${config.envPrefix}_MCP_URL or ${config.envPrefix}_MCP_COMMAND.`);
    client = new StdioMcpClient(parsed.executable, parsed.args, { env: config.env, timeout: config.timeout });
  }
  return client.connect();
}
