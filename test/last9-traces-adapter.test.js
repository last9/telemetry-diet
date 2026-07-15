import assert from 'node:assert/strict';
import test from 'node:test';

import { Last9TracesAdapter } from '../src/providers/last9-traces.js';
import { fakeOAuthClient } from './helpers/fake-oauth-client.js';

test('prefers advertised read-only aggregate trace analysis and returns only normalized evidence', async () => {
  const tools = [
    { name: 'search_traces', description: 'Search trace records', inputSchema: { properties: { limit: {} } } },
    { name: 'delete_trace_aggregates', description: 'Delete trace aggregates' },
    {
      name: 'analyze_trace_aggregates',
      description: 'Read aggregate trace and span statistics',
      annotations: { readOnlyHint: true },
      inputSchema: {
        properties: {
          service_name: {}, environment: {}, start_time_iso: {}, end_time_iso: {}, limit: {},
        },
      },
    },
  ];
  const { calls, oauth } = fakeOAuthClient(tools, {
    analyze_trace_aggregates: {
      data: {
        span_aggregates: [{
          span_kind: 'server',
          span_name: 'GET /items',
          instrumentation_scope: { name: 'http.server' },
          resource_attributes: [
            { key: 'service.name', bytes: 120, safe_to_trim: false, value: 'private-service-value' },
            { key: 'process.command_args', bytes: 480, safe_to_trim: true, value: 'private-command-value' },
          ],
          total_bytes: 2_400,
          span_count: 20,
          error_count: 2,
          http_route: '/items/:id',
          average_duration_ms: 7.5,
          leaf: false,
          low_value: false,
          business_span: true,
        }],
        residual_head_sampling: { ratio: 0.25, credential: 'private-credential-material' },
        fast_success_candidates: { max_average_duration_ms: 10, note: 'private-note' },
      },
    },
  });
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  const connection = await adapter.connect();
  const input = await adapter.collect({
    service: 'example-service',
    environment: 'production',
    timeWindow: { start: '2026-07-15T00:00:00Z', end: '2026-07-15T01:00:00Z' },
  });

  assert.equal(connection.readOnly, true);
  assert.deepEqual(connection.tools, ['analyze_trace_aggregates']);
  assert.deepEqual(calls, [{
    name: 'analyze_trace_aggregates',
    args: {
      service_name: 'example-service',
      environment: 'production',
      start_time_iso: '2026-07-15T00:00:00Z',
      end_time_iso: '2026-07-15T01:00:00Z',
      limit: 200,
    },
  }]);
  assert.deepEqual(input, {
    aggregates: [{
      spanKind: 'SERVER',
      spanName: 'GET /items',
      instrumentationScope: 'http.server',
      resourceAttributes: [
        { key: 'service.name', bytes: 120, safeToTrim: false },
        { key: 'process.command_args', bytes: 480, safeToTrim: true },
      ],
      bytes: 2_400,
      count: 20,
      errorCount: 2,
      httpRoute: '/items/:id',
      averageDurationMs: 7.5,
      leaf: false,
      lowValue: false,
      businessSpan: true,
    }],
    residualHeadSampling: { ratio: 0.25 },
    fastSuccessCandidates: { maxAverageDurationMs: 10 },
  });
  assert.doesNotMatch(JSON.stringify(input), /private-service-value|private-command-value|private-credential-material|private-note/);
});

test('uses a bounded trace-search fallback and keeps unmeasured bytes unknown', async () => {
  const tools = [{
    name: 'get_service_traces',
    description: 'Read traces for a service',
    annotations: { readOnlyHint: true },
    inputSchema: {
      required: ['service', 'page_size'],
      properties: { service: {}, start: {}, end: {}, page_size: {} },
    },
  }];
  const spans = Array.from({ length: 205 }, (_, index) => ({
    span_kind: 'internal',
    name: 'encode payload',
    instrumentation_scope: 'payload.encoder',
    resource_attributes: {
      'service.name': 'private-service-value',
      'process.command_args': 'private-command-value',
    },
    ...(index === 0 ? {} : { size_bytes: 10 }),
    status: index === 1 ? { code: 'ERROR', message: 'private-error-value' } : { code: 'OK' },
    leaf: true,
    low_value: true,
  }));
  const { calls, oauth } = fakeOAuthClient(tools, {
    get_service_traces: { traces: [{ trace_id: 'private-trace-id', spans }] },
  });
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  await adapter.connect();
  const input = await adapter.collect({
    service: 'example-service',
    timeWindow: { start: '2026-07-15T00:00:00Z', end: '2026-07-15T01:00:00Z' },
  });

  assert.deepEqual(calls, [{
    name: 'get_service_traces',
    args: {
      service: 'example-service',
      start: '2026-07-15T00:00:00Z',
      end: '2026-07-15T01:00:00Z',
      page_size: 200,
    },
  }]);
  assert.deepEqual(input, {
    aggregates: [{
      spanKind: 'INTERNAL',
      spanName: 'encode payload',
      instrumentationScope: 'payload.encoder',
      resourceAttributes: [
        { key: 'process.command_args' },
        { key: 'service.name' },
      ],
      count: 200,
      errorCount: 1,
      leaf: true,
      lowValue: true,
      businessSpan: false,
    }],
  });
  assert.equal(Object.hasOwn(input.aggregates[0], 'bytes'), false);
  assert.doesNotMatch(JSON.stringify(input), /private-service-value|private-command-value|private-error-value|private-trace-id/);
});

test('normalizes the Last9 get_service_traces span kind and status constants', async () => {
  const tools = [{
    name: 'get_service_traces',
    description: 'Read traces for a service',
    inputSchema: {
      required: ['service_name'],
      properties: { service_name: {}, start_time_iso: {}, end_time_iso: {}, limit: {}, env: {} },
    },
  }];
  const { calls, oauth } = fakeOAuthClient(tools, {
    get_service_traces: {
      data: [
        {
          trace_id: 'private-trace-1', span_id: 'private-span-1',
          span_kind: 'SPAN_KIND_SERVER', span_name: 'GET /orders', status_code: 'STATUS_CODE_OK',
        },
        {
          trace_id: 'private-trace-2', span_id: 'private-span-2',
          span_kind: 'SPAN_KIND_CLIENT', span_name: 'postgres query', status_code: 'STATUS_CODE_ERROR',
        },
      ],
      success: true,
    },
  });
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  await adapter.connect();
  const input = await adapter.collect({
    service: 'checkout-api',
    environment: 'production',
    timeWindow: { start: '2026-07-15T00:00:00Z', end: '2026-07-15T01:00:00Z' },
  });

  assert.deepEqual(calls, [{
    name: 'get_service_traces',
    args: {
      service_name: 'checkout-api',
      start_time_iso: '2026-07-15T00:00:00Z',
      end_time_iso: '2026-07-15T01:00:00Z',
      limit: 200,
      env: 'production',
    },
  }]);
  assert.deepEqual(input.aggregates.map(({ spanKind, spanName, errorCount }) => ({ spanKind, spanName, errorCount })), [
    { spanKind: 'SERVER', spanName: 'GET /orders', errorCount: 0 },
    { spanKind: 'CLIENT', spanName: 'postgres query', errorCount: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(input), /private-trace|private-span/);
});

test('normalizes direct aggregate lists without inventing bytes or savings', async () => {
  const tools = [{
    name: 'get_span_statistics',
    description: 'Read aggregate span statistics',
    inputSchema: { properties: {} },
  }];
  const { oauth } = fakeOAuthClient(tools, {
    get_span_statistics: [{
      kind: 'client',
      operation_name: 'cache fetch',
      scope_name: 'cache.client',
      resource_attributes: {
        'service.name': 'private-service-value',
        'host.id': 'private-host-value',
      },
      count: 12,
      errors: 0,
    }],
  });
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  await adapter.connect();
  const input = await adapter.collect({ service: 'example-service' });

  assert.deepEqual(input, {
    aggregates: [{
      spanKind: 'CLIENT',
      spanName: 'cache fetch',
      instrumentationScope: 'cache.client',
      resourceAttributes: [{ key: 'service.name' }, { key: 'host.id' }],
      count: 12,
      errorCount: 0,
    }],
  });
  assert.equal(Object.hasOwn(input.aggregates[0], 'bytes'), false);
  assert.doesNotMatch(JSON.stringify(input), /estimated|saving|private-service-value|private-host-value/i);
});

test('fails closed for unsafe or unbounded capabilities and unrecognizable aggregate payloads', async () => {
  const unsafe = fakeOAuthClient([
    { name: 'create_trace_summary', description: 'Create aggregate trace summary' },
    { name: 'analyze_trace_aggregates', description: 'Analyze trace aggregates', annotations: { readOnlyHint: false } },
    { name: 'search_traces', description: 'Search traces', inputSchema: { properties: { query: {} } } },
  ], {});
  const unsafeAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: unsafe.oauth },
  );
  await assert.rejects(
    unsafeAdapter.connect(),
    /read-only aggregate trace analysis capability or a bounded trace-search fallback/i,
  );

  const malformed = fakeOAuthClient([{
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    inputSchema: { properties: {} },
  }], {
    get_trace_aggregates: {
      data: {
        spans: [{ trace_id: 'private-trace-id', attributes: { payload: 'private-attribute-value' } }],
      },
    },
  });
  const malformedAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: malformed.oauth },
  );
  await malformedAdapter.connect();
  await assert.rejects(
    malformedAdapter.collect({ service: 'example-service' }),
    (error) => {
      assert.match(error.message, /no recognizable aggregates/i);
      assert.doesNotMatch(error.message, /private-trace-id|private-attribute-value/i);
      return true;
    },
  );

  const failedCall = fakeOAuthClient([{
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    inputSchema: { properties: {} },
  }], {
    get_trace_aggregates: new Error('sensitive upstream credential detail'),
  });
  const failedCallAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: failedCall.oauth },
  );
  await failedCallAdapter.connect();
  await assert.rejects(
    failedCallAdapter.collect({ service: 'example-service' }),
    (error) => {
      assert.match(error.message, /could not be collected/i);
      assert.doesNotMatch(error.message, /sensitive upstream credential detail/i);
      return true;
    },
  );
});

test('rejects mutating trace tools even when their descriptions and annotations look readable', async () => {
  const tools = ['run', 'execute', 'trigger', 'reset', 'rotate', 'apply'].map((verb) => ({
    name: `${verb}_analyze_trace_aggregates`,
    description: 'Read aggregate trace and span statistics',
    annotations: { readOnlyHint: true },
    inputSchema: { properties: {} },
  }));
  tools.push({
    name: 'custom_trace_aggregate_analysis',
    description: 'Read aggregate trace and span statistics',
    inputSchema: { properties: {} },
  });
  tools.push({
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    annotations: { readOnlyHint: true, destructiveHint: true },
    inputSchema: { properties: {} },
  });
  const { oauth } = fakeOAuthClient(tools, {});
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  await assert.rejects(
    adapter.connect(),
    /read-only aggregate trace analysis capability or a bounded trace-search fallback/i,
  );
});

test('fails closed when aggregate trace evidence exceeds response bounds', async () => {
  const oversized = fakeOAuthClient([{
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    inputSchema: { properties: {} },
  }], {
    get_trace_aggregates: {
      aggregates: Array.from({ length: 201 }, (_, index) => ({
        span_name: `operation-${index}`,
        count: 1,
      })),
    },
  });
  const oversizedAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: oversized.oauth },
  );
  await oversizedAdapter.connect();
  await assert.rejects(
    oversizedAdapter.collect({ service: 'example-service' }),
    /trace aggregate response exceeded safe analysis bounds/i,
  );

  const oversizedAttributes = fakeOAuthClient([{
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    inputSchema: { properties: {} },
  }], {
    get_trace_aggregates: {
      aggregates: [{
        span_name: 'bounded operation',
        count: 1,
        resource_attributes: Array.from({ length: 101 }, (_, index) => ({ key: `attribute.${index}` })),
      }],
    },
  });
  const oversizedAttributesAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: oversizedAttributes.oauth },
  );
  await oversizedAttributesAdapter.connect();
  await assert.rejects(
    oversizedAttributesAdapter.collect({ service: 'example-service' }),
    /trace aggregate response exceeded safe analysis bounds/i,
  );

  const oversizedString = fakeOAuthClient([{
    name: 'get_trace_aggregates',
    description: 'Read trace aggregates',
    inputSchema: { properties: {} },
  }], {
    get_trace_aggregates: {
      aggregates: [{ span_name: 'x'.repeat(513), count: 1 }],
    },
  });
  const oversizedStringAdapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth: oversizedString.oauth },
  );
  await oversizedStringAdapter.connect();
  await assert.rejects(
    oversizedStringAdapter.collect({ service: 'example-service' }),
    /trace aggregate response exceeded safe analysis bounds/i,
  );
});

test('scopes a bounded search_traces fallback with the advertised query schema', async () => {
  const tools = [{
    name: 'search_traces',
    description: 'Search trace records',
    inputSchema: {
      required: ['query', 'limit'],
      properties: { query: {}, from: {}, to: {}, limit: {} },
    },
  }];
  const { calls, oauth } = fakeOAuthClient(tools, {
    search_traces: {
      data: {
        results: [{
          span_id: 'private-span-id',
          span_kind: 'server', name: 'GET /health', instrumentation_scope: 'http.server',
          size_bytes: 100, status: { code: 'OK' },
        }],
      },
    },
  });
  const adapter = new Last9TracesAdapter(
    { TELEMETRY_DIET_LAST9_ORG_SLUG: 'example-org' },
    { oauth },
  );

  await adapter.connect();
  await adapter.collect({
    service: 'example-service',
    environment: 'production',
    timeWindow: { start: '2026-07-15T00:00:00Z', end: '2026-07-15T01:00:00Z' },
  });

  assert.deepEqual(calls, [{
    name: 'search_traces',
    args: {
      query: 'service:example-service env:production',
      from: '2026-07-15T00:00:00Z',
      to: '2026-07-15T01:00:00Z',
      limit: 200,
    },
  }]);
});
