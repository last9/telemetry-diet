import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function unwrapToolResult(result) {
  if (result?.isError) {
    const message = result.content?.map(({ text }) => text).filter(Boolean).join('\n');
    throw new Error(message || 'MCP tool call failed.');
  }
  if (result?.structuredContent != null) return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

export class OAuthRequiredError extends Error {
  constructor(provider, authorizationUrl) {
    super(`Log in with ${provider} to continue.`);
    this.name = 'OAuthRequiredError';
    this.provider = provider;
    this.authorizationUrl = authorizationUrl;
  }
}

class LocalOAuthProvider {
  constructor(provider, redirectUrl) {
    this.provider = provider;
    this._redirectUrl = redirectUrl;
  }

  get redirectUrl() { return this._redirectUrl; }

  get clientMetadata() {
    return {
      client_name: 'Telemetry Diet',
      client_uri: 'https://github.com/last9/telemetry-diet',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    this._state ||= randomBytes(32).toString('base64url');
    return this._state;
  }

  clientInformation() { return this._clientInformation; }
  saveClientInformation(value) { this._clientInformation = value; }
  tokens() { return this._tokens; }
  saveTokens(value) { this._tokens = value; }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString(); }
  saveCodeVerifier(value) { this._codeVerifier = value; }

  codeVerifier() {
    if (!this._codeVerifier) throw new Error('OAuth code verifier is missing. Start login again.');
    return this._codeVerifier;
  }

  validateState(value) {
    if (!value || !this._state) return false;
    const expected = Buffer.from(this._state);
    const received = Buffer.from(value);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  completeFlow() {
    this._state = undefined;
    this.authorizationUrl = undefined;
    this._codeVerifier = undefined;
  }

  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') this._clientInformation = undefined;
    if (scope === 'all' || scope === 'tokens') this._tokens = undefined;
    if (scope === 'all' || scope === 'verifier') this._codeVerifier = undefined;
  }
}

class OAuthMcpClient {
  constructor(session) {
    this.session = session;
    this.serverInfo = null;
  }

  async connect() {
    this.client = new Client({ name: 'telemetry-diet', version: '0.1.0' }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(new URL(this.session.url), {
      authProvider: this.session.oauthProvider,
    });
    this.session.pendingTransport = this.transport;
    this.session.oauthProvider.authorizationUrl = undefined;
    try {
      await this.client.connect(this.transport);
      this.serverInfo = this.client.getServerVersion();
      this.session.pendingTransport = undefined;
      return this;
    } catch (error) {
      if (error instanceof UnauthorizedError && this.session.oauthProvider.authorizationUrl) {
        throw new OAuthRequiredError(this.session.provider, this.session.oauthProvider.authorizationUrl);
      }
      throw error;
    }
  }

  async listTools() {
    return (await this.client.listTools()).tools || [];
  }

  async callTool(name, args = {}) {
    return unwrapToolResult(await this.client.callTool({ name, arguments: args }));
  }

  async close() {
    await this.transport?.close();
  }
}

export class OAuthSessionManager {
  constructor() {
    this.sessions = new Map();
    this.baseUrl = null;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl;
  }

  createClient(provider, url) {
    if (!this.baseUrl) throw new Error('Local OAuth callback is not ready. Restart Telemetry Diet.');
    const redirectUrl = `${this.baseUrl}/oauth/callback/${provider}`;
    let session = this.sessions.get(provider);
    if (!session || session.url !== url || session.oauthProvider.redirectUrl !== redirectUrl) {
      session = { provider, url, oauthProvider: new LocalOAuthProvider(provider, redirectUrl) };
      this.sessions.set(provider, session);
    }
    return new OAuthMcpClient(session);
  }

  async finishAuth(provider, { code, state }) {
    const session = this.sessions.get(provider);
    if (!session?.pendingTransport) throw new Error(`No ${provider} login is waiting for a callback.`);
    if (!session.oauthProvider.validateState(state)) throw new Error('OAuth state validation failed. Start login again.');
    await session.pendingTransport.finishAuth(code);
    session.pendingTransport = undefined;
    session.oauthProvider.completeFlow();
  }
}
