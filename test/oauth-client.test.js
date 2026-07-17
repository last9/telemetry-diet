import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { OAuthRequiredError, OAuthSessionManager } from '../src/mcp/oauth-client.js';

function managerWithClient(provider = 'last9', endpoint = 'https://mcp.example.test/mcp') {
  const manager = new OAuthSessionManager();
  manager.setBaseUrl('http://127.0.0.1:4545');
  return { manager, client: manager.createClient(provider, endpoint) };
}

test('OAuth provider lifecycle keeps credentials in memory and validates state exactly', () => {
  const { client } = managerWithClient();
  const provider = client.session.oauthProvider;

  assert.equal(provider.redirectUrl, 'http://127.0.0.1:4545/oauth/callback/last9');
  assert.deepEqual(provider.clientMetadata.redirect_uris, [provider.redirectUrl]);
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, 'none');
  const state = provider.state();
  assert.equal(provider.state(), state);
  assert.equal(provider.validateState(state), true);
  assert.equal(provider.validateState(`${state}x`), false);
  assert.equal(provider.validateState(''), false);

  assert.throws(() => provider.codeVerifier(), /missing/);
  provider.saveCodeVerifier('pkce-verifier');
  provider.saveClientInformation({ client_id: 'dynamic-client' });
  provider.saveTokens({ access_token: 'memory-only-token' });
  provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
  assert.equal(provider.codeVerifier(), 'pkce-verifier');
  assert.equal(provider.clientInformation().client_id, 'dynamic-client');
  assert.equal(provider.tokens().access_token, 'memory-only-token');
  assert.equal(provider.authorizationUrl, 'https://auth.example.test/authorize');

  provider.invalidateCredentials('tokens');
  assert.equal(provider.tokens(), undefined);
  assert.equal(provider.clientInformation().client_id, 'dynamic-client');
  provider.invalidateCredentials('client');
  assert.equal(provider.clientInformation(), undefined);
  provider.completeFlow();
  assert.equal(provider.validateState(state), false);
  assert.equal(provider.authorizationUrl, undefined);
  assert.throws(() => provider.codeVerifier(), /missing/);
});

test('OAuth session manager validates endpoints and reuses only matching sessions', () => {
  const manager = new OAuthSessionManager();
  assert.throws(() => manager.createClient('last9', 'https://mcp.example.test'), /callback is not ready/i);
  manager.setBaseUrl('http://127.0.0.1:4545');
  assert.throws(() => manager.createClient('last9', 'not a URL'), /valid URL/);
  assert.throws(() => manager.createClient('last9', 'http://mcp.example.test'), /HTTPS or loopback HTTP/);
  assert.doesNotThrow(() => manager.createClient('last9', 'http://localhost:8090/mcp'));

  const first = manager.createClient('last9', 'https://mcp.example.test/mcp');
  const second = manager.createClient('last9', 'https://mcp.example.test/mcp');
  const replacement = manager.createClient('last9', 'https://other.example.test/mcp');
  assert.equal(first.session, second.session);
  assert.notEqual(first.session, replacement.session);
});

test('OAuth callback requires pending login, exact state, and a successful code exchange', async () => {
  const { manager, client } = managerWithClient();
  const provider = client.session.oauthProvider;
  const state = provider.state();
  let receivedCode;
  client.session.pendingTransport = {
    finishAuth: async (code) => { receivedCode = code; },
  };

  await assert.rejects(
    manager.finishAuth('last9', { code: 'code', state: 'wrong-state' }),
    /state validation failed/i,
  );
  await manager.finishAuth('last9', { code: 'one-time-code', state });
  assert.equal(receivedCode, 'one-time-code');
  assert.equal(client.session.pendingTransport, undefined);
  assert.equal(provider.validateState(state), false);
  await assert.rejects(
    manager.finishAuth('last9', { code: 'code', state }),
    /no last9 login is waiting/i,
  );

  const retryState = provider.state();
  client.session.pendingTransport = { finishAuth: async () => { throw new Error('upstream secret'); } };
  await assert.rejects(
    manager.finishAuth('last9', { code: 'code', state: retryState }),
    (error) => /could not be completed/.test(error.message) && !/secret/.test(error.message),
  );
});

test('OAuth MCP wrapper normalizes tool results and sanitizes catalog/tool failures', async () => {
  const { client } = managerWithClient();
  client.client = {
    listTools: async () => ({ tools: [{ name: 'get_service_logs' }] }),
    callTool: async ({ name }) => {
      if (name === 'structured') return { structuredContent: { count: 1 } };
      if (name === 'json') return { content: [{ type: 'text', text: '{"count":2}' }] };
      if (name === 'text') return { content: [{ type: 'text', text: 'plain result' }] };
      return { isError: true, content: [{ type: 'text', text: 'password=hunter2' }] };
    },
  };

  assert.deepEqual(await client.listTools(), [{ name: 'get_service_logs' }]);
  assert.deepEqual(await client.callTool('structured'), { count: 1 });
  assert.deepEqual(await client.callTool('json'), { count: 2 });
  assert.deepEqual(await client.callTool('text'), { text: 'plain result' });
  await assert.rejects(client.callTool('error'), (error) => (
    error.message === 'MCP tool call failed.' && !/hunter2/.test(error.message)
  ));

  client.client.listTools = async () => { throw new Error('catalog secret'); };
  await assert.rejects(client.listTools(), (error) => (
    error.message === 'MCP tool catalog could not be read.' && !/secret/.test(error.message)
  ));
});

test('OAuth MCP connect reports login requirements and sanitizes other failures', async (t) => {
  const { client } = managerWithClient();
  let behavior = 'success';
  t.mock.method(Client.prototype, 'connect', async () => {
    if (behavior === 'login') {
      client.session.oauthProvider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      throw new UnauthorizedError();
    }
    if (behavior === 'failure') throw new Error('provider password=hunter2');
  });
  t.mock.method(Client.prototype, 'getServerVersion', () => ({ name: 'test-mcp', version: '1.0.0' }));
  t.mock.method(StreamableHTTPClientTransport.prototype, 'close', async () => {});

  assert.equal(await client.connect(), client);
  assert.deepEqual(client.serverInfo, { name: 'test-mcp', version: '1.0.0' });
  assert.equal(client.session.pendingTransport, undefined);
  await client.close();

  behavior = 'login';
  await assert.rejects(client.connect(), (error) => (
    error instanceof OAuthRequiredError && error.authorizationUrl === 'https://auth.example.test/authorize'
  ));

  behavior = 'failure';
  await assert.rejects(client.connect(), (error) => (
    error.message === 'MCP OAuth connection failed.' && !/hunter2/.test(error.message)
  ));
});
