import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedFromPayload, toolArgs } from '../src/providers/helpers.js';

test('vendor records are normalized without retaining raw records', () => {
  const context = {
    provider: 'datadog', service: 'checkout-api', environment: 'production',
    timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
  };
  const summary = normalizedFromPayload({ total: 22, logs: [{
    message: 'GET /healthz 200 user=alex@example.com',
    severity: 'INFO',
    attributes: { 'url.path': '/healthz', 'http.response.status_code': 200, 'user.email': 'alex@example.com' },
  }] }, context);
  assert.equal(summary.recordsAnalyzed, 22);
  assert.equal(summary.provider, 'datadog');
  assert.equal(Object.hasOwn(summary, 'logs'), false);
  assert.doesNotMatch(JSON.stringify(summary), /alex@example\.com/);
});

test('tool argument mapping respects actual MCP input schemas', () => {
  const tool = { inputSchema: { required: ['query', 'from', 'to', 'limit'], properties: { query: {}, from: {}, to: {}, limit: {} } } };
  assert.deepEqual(toolArgs(tool, { query: 'service:api', start: 'start', end: 'end', limit: 200 }), {
    query: 'service:api', from: 'start', to: 'end', limit: 200,
  });
});

test('MCP argument aliases map to provider-advertised schemas', () => {
  const tool = { inputSchema: { properties: {
    service_name: {}, env: {}, start_time_iso: {}, end_time_iso: {}, limit: {},
  } } };
  assert.deepEqual(toolArgs(tool, {
    service: 'checkout-api', environment: 'production', start: 'start', end: 'end', limit: 10,
  }), {
    service_name: 'checkout-api', env: 'production', start_time_iso: 'start', end_time_iso: 'end', limit: 10,
  });
});
