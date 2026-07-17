import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { createTelemetryDietServer, listen } from '../src/server.js';

async function startServer(t) {
  const server = createTelemetryDietServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  server.setBaseUrl(baseUrl);
  t.after(async () => {
    await server.closeProviders();
    await new Promise((resolve) => { server.close(resolve); });
  });
  return baseUrl;
}

test('listener rejects non-loopback bind addresses', async () => {
  const server = createTelemetryDietServer();
  await assert.rejects(listen(server, { host: '0.0.0.0', port: 4545 }), /only listens on localhost/i);
});

test('local server rejects DNS-rebinding Host headers and cross-origin requests', async (t) => {
  const baseUrl = await startServer(t);
  const target = new URL(baseUrl);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: '/api/health', headers: { host: 'evil.example' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHostStatus, 403);

  const crossOrigin = await fetch(`${baseUrl}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ provider: 'sample' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /cross-origin/i);
});

test('API requires JSON and bounds analysis scope', async (t) => {
  const baseUrl = await startServer(t);
  const wrongType = await fetch(`${baseUrl}/api/connect`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"provider":"sample"}',
  });
  assert.equal(wrongType.status, 415);

  const connect = await fetch(`${baseUrl}/api/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'sample' }),
  });
  assert.equal(connect.status, 200);

  const oversizedWindow = await fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'sample', service: 'checkout-api', environment: 'production',
      timeWindow: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-09T00:00:00.000Z' },
    }),
  });
  assert.equal(oversizedWindow.status, 400);
  assert.match((await oversizedWindow.json()).error, /cannot exceed 7 days/i);
});

test('OAuth denial errors do not echo provider-controlled query text', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/oauth/callback/datadog?error=password%3Dhunter2`);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /was not authorized/i);
  assert.doesNotMatch(JSON.stringify(payload), /hunter2/);
});
