import assert from 'node:assert/strict';
import test from 'node:test';

import { findTool, resultLimitForTool, toolArgs } from '../src/providers/helpers.js';
import { Last9Adapter } from '../src/providers/last9.js';
import { isSafeLast9ReadTool } from '../src/providers/last9-tool-safety.js';
import { normalizeLast9Logs } from '../src/providers/last9-normalize.js';

// Contract vector from last9/last9-mcp-server at
// 96c1e72340855d2ce31b9a1aa5cab4b404fd6962, internal/telemetry/logs/service_logs.go.
const last9ServiceLogsTool = Object.freeze({
  name: 'get_service_logs',
  inputSchema: {
    type: 'object',
    required: ['service_name'],
    properties: {
      service_name: { type: 'string' },
      start_time_iso: { type: 'string' },
      end_time_iso: { type: 'string' },
      lookback_minutes: { type: 'integer', minimum: 1 },
      limit: { type: 'integer' },
      severity_filters: { type: 'array', items: { type: 'string' } },
      body_filters: { type: 'array', items: { type: 'string' } },
      env: { type: 'string' },
      index: { type: 'string' },
    },
  },
});

// Contract vector from last9/last9-mcp-server at
// c4136bdd6dde51b932a371ce1a4f365346741dd1, internal/telemetry/logs/service_logs_input_schema.go
// (last9-mcp-server#431). Over 20 lines, the default "summary" mode replaces `logs` with `summary`.
const last9SummarizingServiceLogsTool = Object.freeze({
  name: 'get_service_logs',
  inputSchema: {
    ...last9ServiceLogsTool.inputSchema,
    properties: {
      ...last9ServiceLogsTool.inputSchema.properties,
      http_status_class: { type: ['string', 'null'] },
      http_status_code: { type: ['string', 'null'] },
      http_status_field: { type: ['string', 'null'] },
      attribute_filters: { type: ['array', 'null'] },
      response_mode: { type: ['string', 'null'] },
    },
  },
});

// Contract vector from last9/last9-mcp-server at
// dae74d3e929b822dcd6d4b031085e5fdc4dc6f2b, internal/apm/apm.go (PromqlInstantQueryArgs,
// NewPromqlInstantQueryHandler). The handler returns the raw Prometheus instant-query HTTP
// response body as text content: `{status, data: {resultType, result: [{metric, value}]}}`.
const last9PrometheusInstantQueryTool = Object.freeze({
  name: 'prometheus_instant_query',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      time_iso: { type: 'string' },
      lookback_minutes: { type: 'number', minimum: 1 },
      datasource: { type: 'string' },
    },
  },
});

const timeWindow = {
  start: '2026-07-14T10:00:00.000Z',
  end: '2026-07-14T16:00:00.000Z',
};

test('current Last9 service-log contract receives exact bounded scope arguments', () => {
  assert.deepEqual(resultLimitForTool(last9ServiceLogsTool, 200), { key: 'limit', value: 200 });
  assert.deepEqual(toolArgs(last9ServiceLogsTool, {
    service: 'checkout-api', environment: 'production',
    start: timeWindow.start, end: timeWindow.end, limit: 200,
  }), {
    service_name: 'checkout-api',
    start_time_iso: timeWindow.start,
    end_time_iso: timeWindow.end,
    limit: 200,
    env: 'production',
  });
});

async function last9ServiceLogsArgs(logsTool) {
  const calls = [];
  const adapter = new Last9Adapter({});
  adapter.summaryTool = { name: 'get_service_summary', inputSchema: { properties: { service_name: {}, limit: {} } } };
  adapter.logsTool = logsTool;
  adapter.logsLimit = resultLimitForTool(logsTool, 200);
  adapter.client = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_service_summary') return {};
    if (name === 'get_service_logs') return { count: 1, logs: [{ message: 'checkout completed', severity: 'INFO' }] };
    throw new Error(`Unexpected tool: ${name}`);
  } };
  await adapter.analyze({ service: 'checkout-api', environment: 'production', timeWindow });
  assert.deepEqual(calls.find(({ name }) => name === 'get_service_summary').args, { service_name: 'checkout-api', limit: 200 });
  return calls.find(({ name }) => name === 'get_service_logs').args;
}

test('Last9 analysis asks a summarizing get_service_logs for raw lines', async () => {
  assert.deepEqual(await last9ServiceLogsArgs(last9SummarizingServiceLogsTool), {
    service_name: 'checkout-api',
    start_time_iso: timeWindow.start,
    end_time_iso: timeWindow.end,
    limit: 200,
    env: 'production',
    response_mode: 'raw',
  });
});

test('Last9 analysis sends no response_mode to a get_service_logs that does not advertise it', async () => {
  const args = await last9ServiceLogsArgs(last9ServiceLogsTool);
  assert.equal(Object.hasOwn(args, 'response_mode'), false);
});

test('Last9 summary-mode log response is not mistaken for a log collection', () => {
  assert.equal(normalizeLast9Logs({
    service: 'checkout-api',
    count: 200,
    summary: {
      lines_summarized: 200,
      severity_counts: { INFO: 200 },
      histogram: { start: timeWindow.start, bucket_seconds: 2160, counts: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] },
      patterns: [{ template: 'checkout completed', count: 200, samples: ['checkout completed'] }],
      hint: 'Summary of the returned lines. Pass response_mode "raw" for the lines themselves.',
    },
  }, { provider: 'last9', service: 'checkout-api', environment: 'production', timeWindow }, { limit: 200 }), null);
});

test('current Last9 response contract preserves partial evidence without raw records', () => {
  const summary = normalizeLast9Logs({
    service: 'checkout-api',
    start_time: timeWindow.start,
    end_time: timeWindow.end,
    count: 1,
    logs: [{
      timestamp: '2026-07-14T11:00:00.000Z',
      message: 'checkout completed',
      severity: 'INFO',
      service_name: 'checkout-api',
    }],
    partial_result: true,
    warning: 'one time-range chunk was unavailable',
  }, {
    provider: 'last9', service: 'checkout-api', environment: 'production', timeWindow,
  }, { limit: 200 });

  assert.equal(summary.recordsAnalyzed, 1);
  assert.match(summary.limitations.join('\n'), /partial result/);
  assert.match(summary.limitations.join('\n'), /one time-range chunk was unavailable/);
  assert.equal(Object.hasOwn(summary, 'logs'), false);
  assert.equal(Object.hasOwn(summary, 'warning'), false);
});

test('current Last9 PromQL instant-query contract passes the metrics-adapter safety gate on its exact alias', () => {
  const aliases = ['prometheus_instant_query', 'instant_query', 'query_instant', 'prometheus_query'];
  assert.equal(isSafeLast9ReadTool(last9PrometheusInstantQueryTool, aliases), true);
  assert.equal(
    isSafeLast9ReadTool({ ...last9PrometheusInstantQueryTool, name: 'add_prometheus_instant_query' }, aliases),
    false,
  );
  assert.equal(
    isSafeLast9ReadTool({ ...last9PrometheusInstantQueryTool, annotations: { destructiveHint: true } }, aliases),
    false,
  );
});

test('current provider catalogs resolve read tools and reject similarly named writes', () => {
  const catalog = [
    { name: 'search_datadog_services' },
    { name: 'analyze_datadog_logs' },
    { name: 'search_datadog_logs' },
    { name: 'add_drop_rule', annotations: { readOnlyHint: true } },
  ];

  assert.equal(findTool(catalog, ['search_datadog_services']).name, 'search_datadog_services');
  assert.equal(findTool(catalog, ['analyze_datadog_logs']).name, 'analyze_datadog_logs');
  assert.equal(findTool(catalog, ['search_datadog_logs']).name, 'search_datadog_logs');
  assert.equal(findTool(catalog, ['add_drop_rule']), undefined);
});
