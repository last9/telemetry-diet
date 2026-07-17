import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelemetryDietServer } from '../src/server.js';

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

async function json(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}

async function errorJson(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  assert.equal(response.ok, false);
  return data;
}

test('sample metrics route returns a restorable organization-wide usage report', async (t) => {
  const baseUrl = await startServer(t);
  await json(baseUrl, '/api/connect', { provider: 'sample' });

  const analysis = await json(baseUrl, '/api/analyze', { provider: 'sample', signal: 'metrics' });

  assert.equal(analysis.analysisType, 'metrics');
  assert.equal(analysis.result.summary.catalogCount, 5);
  assert.ok(analysis.result.metrics.some(({ status }) => status === 'unreferenced'));
  assert.match(analysis.artifacts.markdown, /unreferenced in scanned sources/i);
  assert.equal(typeof analysis.artifacts.json, 'object');

  const restored = await json(baseUrl, `/api/analysis/${analysis.analysisId}`);
  assert.deepEqual(restored, analysis);
});
test('sample traces route returns ticket-grounded byte-first recommendations and visible drafts', async (t) => {
  const baseUrl = await startServer(t);
  await json(baseUrl, '/api/connect', { provider: 'sample' });

  const analysis = await json(baseUrl, '/api/analyze', {
    provider: 'sample',
    signal: 'traces',
    service: 'checkout-api',
    environment: 'production',
    timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
  });

  assert.equal(analysis.analysisType, 'traces');
  assert.ok(analysis.result.summary.totalBytes > 0);
  const categories = new Set(analysis.result.recommendations.map(({ category }) => category));
  assert.equal(categories.has('span-name-normalization'), true);
  assert.equal(categories.has('health-route-candidate'), true);
  assert.equal(categories.has('fast-success-cohort'), true);
  assert.equal(analysis.result.recommendations.at(-1).category, 'residual-head-sampling');
  assert.match(analysis.artifacts.collector, /export-only|draft/i);
  assert.match(analysis.artifacts.collector, /replace_pattern\(name,/);
  assert.match(analysis.artifacts.ottl, /export-only|draft/i);
  assert.match(analysis.artifacts.ottl, /http\.route/);
  assert.match(analysis.artifacts.ottl, /Fast-success sampling candidates: 1/);
  assert.equal('otel' in analysis.artifacts, false);
  assert.match(analysis.artifacts.markdown, /Trace intelligence/i);
});

test('metric and trace routes reject missing or unknown providers', async (t) => {
  const baseUrl = await startServer(t);
  for (const provider of [undefined, 'unknown']) {
    const metrics = await errorJson(baseUrl, '/api/analyze', { provider, signal: 'metrics' });
    assert.match(metrics.error, /sample provider or Last9 MCP/i);
    const traces = await errorJson(baseUrl, '/api/analyze', {
      provider,
      signal: 'traces',
      service: 'checkout-api',
      timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
    });
    assert.match(traces.error, /sample provider or Last9 MCP/i);
  }
});

test('existing log route preserves its original response, storage, and generation contract', async (t) => {
  const baseUrl = await startServer(t);
  await json(baseUrl, '/api/connect', { provider: 'sample' });
  const input = {
    provider: 'sample',
    service: 'checkout-api',
    environment: 'production',
    timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
  };

  const analysis = await json(baseUrl, '/api/analyze', input);
  assert.equal('analysisType' in analysis, false);
  assert.ok(Array.isArray(analysis.findings));
  const restored = await json(baseUrl, `/api/analysis/${analysis.analysisId}`);
  assert.equal('analysisType' in restored, false);
  assert.deepEqual(restored.summary, analysis.summary);
  assert.deepEqual(restored.findings, analysis.findings);
  const generated = await json(baseUrl, '/api/generate', { analysisId: analysis.analysisId, selectedIds: [] });
  assert.ok(generated.artifacts.preview);
});
