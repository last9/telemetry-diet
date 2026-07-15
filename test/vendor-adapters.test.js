import assert from 'node:assert/strict';
import test from 'node:test';
import { DatadogAdapter, resolveDatadogMcpConfig } from '../src/providers/datadog.js';
import { Last9Adapter } from '../src/providers/last9.js';

const timeWindow = { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' };
const normalized = {
  recordsAnalyzed: 100,
  fields: [{ name: 'request.id', presence: 100, uniqueCount: 100, uniqueRatio: 1 }],
  messages: [{ fingerprint: 'request complete', count: 100, severity: 'INFO' }],
  endpoints: [{ path: '/checkout', count: 100, statusClass: '2xx', method: 'POST' }],
};

test('Datadog MCP configuration defaults to provider OAuth', () => {
  assert.deepEqual(resolveDatadogMcpConfig({}).mode, 'hosted-oauth');
  assert.deepEqual(resolveDatadogMcpConfig({ TELEMETRY_DIET_DATADOG_MCP_URL: 'https://example.test/mcp' }).mode, 'hosted-oauth');
  assert.deepEqual(resolveDatadogMcpConfig({ TELEMETRY_DIET_DATADOG_MCP_TOKEN: 'token' }).mode, 'http-token');
  assert.deepEqual(resolveDatadogMcpConfig({ TELEMETRY_DIET_DATADOG_MCP_COMMAND: '["datadog-mcp"]' }).mode, 'custom-command');
});

test('Datadog adapter uses service discovery and aggregate analysis read tools', async () => {
  const calls = [];
  const adapter = new DatadogAdapter({ TELEMETRY_DIET_DATADOG_ENVIRONMENTS: 'prod' });
  adapter.serviceTool = { name: 'search_datadog_services', inputSchema: { properties: { query: {}, limit: {} } } };
  adapter.analysisTool = { name: 'analyze_datadog_logs', inputSchema: { required: ['sql_query', 'telemetry'], properties: { sql_query: {}, filter: {}, extra_columns: {}, from: {}, to: {}, telemetry: {} } } };
  adapter.searchTool = { name: 'search_datadog_logs', inputSchema: { required: ['query', 'telemetry'], properties: { query: {}, max_tokens: {}, telemetry: {} } } };
  adapter.client = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'search_datadog_services') return { services: [{ name: 'checkout-api' }] };
    if (name === 'analyze_datadog_logs') return normalized;
    throw new Error(`Unexpected tool: ${name}`);
  } };
  assert.deepEqual(await adapter.discoverServices(), ['checkout-api']);
  const summary = await adapter.analyze({ service: 'checkout-api', environment: 'prod', timeWindow });
  assert.equal(summary.provider, 'datadog');
  assert.deepEqual(calls.map(({ name }) => name), ['search_datadog_services', 'analyze_datadog_logs']);
  assert.match(calls[1].args.sql_query, /COUNT\(\*\) AS records_analyzed/);
  assert.equal(calls[1].args.filter, 'service:checkout-api env:prod');
});

test('Datadog detail fallback is summary-first, RBAC-scoped, and hard-bounded to 10 events', async () => {
  const calls = [];
  const adapter = new DatadogAdapter({});
  adapter.analysisTool = { name: 'analyze_datadog_logs', inputSchema: { required: ['sql_query', 'telemetry'], properties: { sql_query: {}, filter: {}, extra_columns: {}, from: {}, to: {}, max_tokens: {}, telemetry: {} } } };
  adapter.searchTool = { name: 'search_datadog_logs', inputSchema: { required: ['query', 'telemetry'], properties: { query: {}, max_tokens: {}, from: {}, to: {}, extra_fields: {}, telemetry: {} } } };
  adapter.client = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'analyze_datadog_logs' && calls.filter((call) => call.name === name).length === 1) {
      return { rows: [{ records_analyzed: 50, user_email_presence: 5, user_email_unique_count: 5 }] };
    }
    if (name === 'analyze_datadog_logs') {
      return { rows: [{ message: 'GET /healthz 200', severity: 'INFO', path: '/healthz', method: 'GET', status_code: 200, record_count: 20 }] };
    }
    if (name === 'search_datadog_logs') {
      return { total: 50, logs: [{ message: 'checkout user alex@example.com', severity: 'INFO', attributes: { 'user.email': 'alex@example.com' } }] };
    }
    throw new Error(`Unexpected tool: ${name}`);
  } };
  const summary = await adapter.analyze({ service: 'checkout-api', environment: 'production', timeWindow });
  assert.deepEqual(calls.map(({ name }) => name), ['analyze_datadog_logs', 'analyze_datadog_logs', 'search_datadog_logs']);
  assert.equal(calls[2].args.max_tokens, 3000);
  assert.match(calls[0].args.sql_query, /COUNT\(DISTINCT "@user\.email"\)/);
  assert.match(calls[1].args.sql_query, /GROUP BY status, "@http\.url_details\.path"/);
  assert.equal(summary.recordsAnalyzed, 50);
  assert.doesNotMatch(JSON.stringify(summary), /alex@example\.com/);
  assert.match(JSON.stringify(summary.limitations), /RBAC/);
});

test('Last9 adapter reads summaries, attributes, environments, and existing rules without writes', async () => {
  const calls = [];
  const adapter = new Last9Adapter({ TELEMETRY_DIET_LAST9_SERVICE: 'checkout-api' });
  adapter.summaryTool = { name: 'get_service_summary', inputSchema: { properties: { service: {} } } };
  adapter.environmentsTool = { name: 'get_service_environments', inputSchema: { properties: { service: {} } } };
  adapter.logsTool = { name: 'get_service_logs', inputSchema: { properties: { service: {}, limit: {} } } };
  adapter.attributesTool = { name: 'get_log_attributes', inputSchema: { properties: { service: {}, from: {}, to: {} } } };
  adapter.rulesTool = { name: 'get_drop_rules', inputSchema: { properties: { service: {} } } };
  adapter.client = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_service_environments') return ['production'];
    if (name === 'get_service_summary') return { name: 'checkout-api' };
    if (name === 'get_log_attributes') return normalized;
    if (name === 'get_drop_rules') return { rules: [{ name: 'retain-errors', type: 'retention', description: 'Keep errors' }] };
    if (name === 'get_service_logs') return { count: 1, logs: [{ message: 'checkout complete', severity: 'INFO', service_name: 'checkout-api' }] };
    throw new Error(`Unexpected tool: ${name}`);
  } };
  assert.deepEqual(await adapter.discoverServices(), ['checkout-api']);
  assert.deepEqual(await adapter.getEnvironments('checkout-api'), ['*', 'production']);
  const summary = await adapter.analyze({ service: 'checkout-api', environment: 'production', timeWindow });
  assert.equal(summary.provider, 'last9');
  assert.equal(summary.existingPolicies[0].name, 'retain-errors');
  assert.ok(calls.every(({ name }) => !/add|create|update|delete/i.test(name)));
  assert.ok(calls.some(({ name }) => name === 'get_service_logs'));
});
