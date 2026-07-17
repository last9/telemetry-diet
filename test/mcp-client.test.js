import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMcpChildEnvironment, HttpMcpClient, parseCommand } from '../src/mcp/client.js';
import { OAuthRequiredError } from '../src/mcp/oauth-client.js';

test('HTTP MCP requests abort at the configured timeout', async (t) => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  }));
  const client = new HttpMcpClient('https://mcp.invalid', { timeout: 5 });

  await assert.rejects(client.request('tools/list', {}), /MCP HTTP request timed out: tools\/list/i);
  assert.equal(aborted, true);
});

test('stdio MCP children inherit only base process settings and explicitly allowlisted credentials', () => {
  const child = buildMcpChildEnvironment({
    Path: '/usr/bin', HOME: '/tmp/example-home', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DD_API_KEY: 'dd-secret', TELEMETRY_DIET_DATADOG_MCP_ENV_ALLOWLIST: 'DD_API_KEY',
  }, 'TELEMETRY_DIET_DATADOG');

  assert.equal(child.Path, '/usr/bin');
  assert.equal(child.HOME, '/tmp/example-home');
  assert.equal(child.DD_API_KEY, 'dd-secret');
  assert.equal('AWS_SECRET_ACCESS_KEY' in child, false);
  assert.equal('TELEMETRY_DIET_DATADOG_MCP_ENV_ALLOWLIST' in child, false);
});

test('HTTP MCP responses are size-bounded before parsing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"jsonrpc":"2.0","result":{}}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '1000' },
  }));
  const client = new HttpMcpClient('https://mcp.invalid', { maxResponseBytes: 100 });

  await assert.rejects(client.request('tools/list', {}), /exceeded the safe size limit/i);
});

test('HTTP MCP failures do not echo upstream response bodies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('password=hunter2', { status: 500 }));
  const client = new HttpMcpClient('https://mcp.invalid');

  await assert.rejects(client.request('tools/list', {}), (error) => (
    /status 500/.test(error.message) && !/hunter2/.test(error.message)
  ));
});

test('MCP endpoints require encrypted remote transport and authorization URLs', () => {
  assert.throws(() => new HttpMcpClient('http://mcp.example'), /HTTPS or loopback HTTP/i);
  assert.doesNotThrow(() => new HttpMcpClient('http://127.0.0.1:8080/mcp'));
  assert.throws(() => new OAuthRequiredError('example', 'javascript:alert(1)'), /HTTPS or loopback HTTP/i);
});

test('stdio command configuration accepts only arrays of strings', () => {
  assert.deepEqual(parseCommand('["node","server.js"]'), { executable: 'node', args: ['server.js'] });
  assert.throws(() => parseCommand('[{"command":"node"}]'), /array of strings/i);
  assert.throws(() => parseCommand('node server.js', '[1]'), /array of strings/i);
});
