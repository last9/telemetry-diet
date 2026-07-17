import assert from 'node:assert/strict';
import test from 'node:test';

import { findTool, resultLimitForTool, toolArgs } from '../src/providers/helpers.js';
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
