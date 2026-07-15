import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMcpClient } from '../src/mcp/client.js';

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
