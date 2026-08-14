import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvider } from '../src/providers/index.js';
import { Last9SessionAdapter } from '../src/providers/last9-session.js';
import { fakeOAuthClient } from './helpers/fake-oauth-client.js';

const env = {};

test('Last9 connection accepts a metric-only read session', async () => {
  const tools = [
    { name: 'get_metric_names', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    { name: 'list_dashboards', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
  ];
  const { oauth } = fakeOAuthClient(tools, {});
  const adapter = createProvider('last9', env, { oauth });

  assert.ok(adapter instanceof Last9SessionAdapter);
  const connection = await adapter.connect();
  assert.equal(connection.readOnly, true);
  assert.deepEqual(connection.tools, ['get_metric_names', 'list_dashboards']);
  assert.deepEqual(await adapter.discoverServices(), []);
  await adapter.close();
});

test('Last9 connection accepts a trace-only read session', async () => {
  const tools = [
    { name: 'analyze_trace_aggregates', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
  ];
  const { oauth } = fakeOAuthClient(tools, {});
  const adapter = createProvider('last9', env, { oauth });

  const connection = await adapter.connect();
  assert.deepEqual(connection.tools, ['analyze_trace_aggregates']);
  assert.deepEqual(await adapter.getEnvironments(), ['*', 'production']);
  await adapter.close();
});

test('Last9 connection applies the shared fail-closed tool safety policy', async () => {
  const tools = [
    { name: 'get_service_summary', inputSchema: { properties: {} } },
    { name: 'tenant_get_metric_names', inputSchema: { properties: {} } },
    { name: 'run_get_metric_names', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    {
      name: 'get_service_environments',
      annotations: { readOnlyHint: true, destructiveHint: true },
      inputSchema: { properties: {} },
    },
    {
      name: 'tenant_get_metric_names',
      annotations: { readOnlyHint: true },
      inputSchema: { properties: {} },
    },
  ];
  const { oauth } = fakeOAuthClient(tools, {});
  const adapter = new Last9SessionAdapter(env, { oauth });

  const connection = await adapter.connect();
  assert.deepEqual(connection.tools, ['get_service_summary', 'tenant_get_metric_names']);
  await adapter.close();
});

test('Last9 connection advertises every safe PromQL instant-query alias', async () => {
  const queryAliases = [
    'prometheus_instant_query',
    'instant_query',
    'query_instant',
    'prometheus_query',
  ];
  const tools = [
    ...queryAliases.map((name) => ({
      name,
      annotations: { readOnlyHint: true },
      inputSchema: { required: ['query'], properties: { query: {} } },
    })),
    {
      name: 'update_prometheus_instant_query',
      annotations: { readOnlyHint: true },
      inputSchema: { required: ['query'], properties: { query: {} } },
    },
  ];
  const { oauth } = fakeOAuthClient(tools, {});
  const adapter = new Last9SessionAdapter(env, { oauth });

  const connection = await adapter.connect();

  assert.deepEqual(connection.tools, queryAliases);
  await adapter.close();
});
