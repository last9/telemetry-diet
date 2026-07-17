import assert from 'node:assert/strict';
import test from 'node:test';
import { findTool, normalizedFromPayload, providerQuery, resultLimitForTool, toolArgs } from '../src/providers/helpers.js';

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

test('normalized aggregate summaries discard provider fields outside the public evidence model', () => {
  const summary = normalizedFromPayload({
    fields: [], messages: [], endpoints: [], recordsAnalyzed: 1,
    rawRecords: [{ password: 'hunter2' }], upstreamCredential: 'private-value',
  }, { provider: 'datadog', service: 'api', environment: 'production', timeWindow: {} });

  assert.equal(Object.hasOwn(summary, 'rawRecords'), false);
  assert.equal(Object.hasOwn(summary, 'upstreamCredential'), false);
  assert.doesNotMatch(JSON.stringify(summary), /hunter2|private-value/);
});

test('record normalization redacts short key-identified secrets and does not duplicate nested attributes', () => {
  const context = { provider: 'last9', service: 'api', environment: 'production', timeWindow: {} };
  const summary = normalizedFromPayload({ logs: [{
    message: 'login rejected password=hunter2',
    password: 'top-level-secret',
    attributes: { password: 'hunter2', 'user.email': 'alex@example.com' },
  }] }, context);
  const serialized = JSON.stringify(summary);

  assert.doesNotMatch(serialized, /hunter2|top-level-secret|alex@example\.com/);
  assert.equal(summary.fields.filter(({ name }) => name === 'password').length, 1);
  assert.equal(summary.fields.some(({ name }) => name === 'attributes.password'), false);
  assert.deepEqual(summary.fields.find(({ name }) => name === 'password').examplesRedacted, ['[REDACTED]']);
});

test('known provider tools fail closed for unsafe annotations and mutating suffix wrappers', () => {
  const tools = [
    { name: 'search_datadog_logs', annotations: { readOnlyHint: false } },
    { name: 'delete_search_datadog_logs', annotations: { readOnlyHint: true } },
    { name: 'tenant_search_datadog_logs', annotations: { readOnlyHint: true } },
  ];
  assert.equal(findTool(tools, ['search_datadog_logs']).name, 'tenant_search_datadog_logs');
  assert.equal(findTool(tools.slice(0, 2), ['search_datadog_logs']), undefined);
});

test('raw-record tool limits must be advertised and enforce the requested ceiling', () => {
  assert.deepEqual(resultLimitForTool({ inputSchema: { properties: { page_size: { maximum: 50 } } } }, 200), { key: 'page_size', value: 50 });
  assert.equal(resultLimitForTool({ inputSchema: { properties: { max_tokens: {} } } }, 10), null);
  assert.equal(resultLimitForTool({ inputSchema: { properties: { limit: { minimum: 100 } } } }, 10), null);
});

test('provider query values are quoted and escaped instead of broadening filters', () => {
  assert.equal(providerQuery('checkout api', 'prod" OR *'), 'service:"checkout api" env:"prod\\" OR *"');
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

test('optional provider time aliases are scoped even when the schema does not require them', () => {
  const tool = { inputSchema: { properties: {
    service_name: {}, start_time: {}, end_time: {}, limit: {},
  } } };
  assert.deepEqual(toolArgs(tool, {
    service: 'checkout-api', start: 'start', end: 'end', limit: 10,
  }), {
    service_name: 'checkout-api', start_time: 'start', end_time: 'end', limit: 10,
  });

  const windowTool = { inputSchema: { properties: { time_window: {} } } };
  assert.deepEqual(toolArgs(windowTool, { start: 'start', end: 'end' }), {
    time_window: { start: 'start', end: 'end' },
  });
});
