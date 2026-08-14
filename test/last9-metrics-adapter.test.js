import assert from 'node:assert/strict';
import test from 'node:test';
import { Last9MetricsAdapter } from '../src/providers/last9-metrics.js';
import { fakeOAuthClient } from './helpers/fake-oauth-client.js';

test('collects metric inventory and preserves exact query provenance from advertised read tools', async () => {
  const tools = [
    { name: 'delete_metric_catalog', description: 'Delete metric names' },
    { name: 'read_metric_catalog', description: 'Read metric name inventory', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    { name: 'fetch_native_dashboard_definitions', description: 'Fetch native dashboards and panel queries', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    { name: 'query_embedded_grafana_dashboards', description: 'Read embedded Grafana dashboard definitions', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    { name: 'list_alert_definitions', description: 'List alert rules and queries', inputSchema: { properties: {} } },
    { name: 'get_entity_kpis', description: 'Get entity indicator KPI queries', inputSchema: { properties: {} } },
  ];
  const { calls, oauth } = fakeOAuthClient(tools, {
    read_metric_catalog: { data: { metric_names: ['queue_depth', 'http_requests_total', 'queue_depth'] } },
    fetch_native_dashboard_definitions: {
      dashboards: [{
        id: 'native-1', name: 'Operations', updated_at: '2026-07-14T10:00:00Z',
        panels: [{
          id: 'row-1', title: 'HTTP', panels: [{
            id: 'panel-1', title: 'Request rate',
            queries: [
              { refId: 'A', query: 'sum(rate(http_requests_total[5m]))' },
              { refId: 'B', definition: { query: 'max(queue_depth)' } },
            ],
          }],
        }],
      }],
    },
    query_embedded_grafana_dashboards: {
      dashboards: [{
        uid: 'grafana-1', title: 'Capacity', updatedAt: '2026-07-14T11:00:00Z',
        panels: [{ id: 7, title: 'Queue', targets: [{ refId: 'A', expr: 'avg(queue_depth)' }] }],
      }],
    },
    list_alert_definitions: {
      groups: [{ name: 'API alerts', rules: [{ id: 'alert-1', name: 'Traffic high', expr: 'sum(http_requests_total)', updated_at: '2026-07-14T12:00:00Z' }] }],
    },
    get_entity_kpis: {
      entities: [{ id: 'entity-1', name: 'API', kpis: [{ id: 'kpi-1', name: 'Queue health', definition: { query: 'max(queue_depth)' } }] }],
    },
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth, now: () => new Date('2026-07-15T00:00:00Z') },
  );

  const connection = await adapter.connect();
  const snapshot = await adapter.collect();

  assert.equal(connection.readOnly, true);
  assert.deepEqual(snapshot.metricNames, ['http_requests_total', 'queue_depth']);
  assert.equal(snapshot.capturedAt, '2026-07-15T00:00:00.000Z');
  assert.deepEqual(snapshot.warnings, [
    'Last9 MCP does not advertise a PromQL query capability; scrape-volume configuration was not reviewed.',
  ]);
  assert.equal(snapshot.scrapeVolume, null);
  assert.deepEqual(snapshot.references, [
    { kind: 'dashboard', sourceId: 'native-1', sourceName: 'Operations > HTTP > Request rate > A', query: 'sum(rate(http_requests_total[5m]))', updatedAt: '2026-07-14T10:00:00Z' },
    { kind: 'dashboard', sourceId: 'native-1', sourceName: 'Operations > HTTP > Request rate > B', query: 'max(queue_depth)', updatedAt: '2026-07-14T10:00:00Z' },
    { kind: 'dashboard', sourceId: 'grafana-1', sourceName: 'Capacity > Queue > A', query: 'avg(queue_depth)', updatedAt: '2026-07-14T11:00:00Z' },
    { kind: 'alert', sourceId: 'alert-1', sourceName: 'API alerts > Traffic high', query: 'sum(http_requests_total)', updatedAt: '2026-07-14T12:00:00Z' },
    { kind: 'indicator', sourceId: 'kpi-1', sourceName: 'API > Queue health', query: 'max(queue_depth)', updatedAt: null },
  ]);
  assert.deepEqual(calls.map(({ name }) => name), [
    'read_metric_catalog',
    'fetch_native_dashboard_definitions',
    'query_embedded_grafana_dashboards',
    'list_alert_definitions',
    'get_entity_kpis',
  ]);
  assert.ok(calls.every(({ name }) => !/delete|create|update|write/i.test(name)));
});

test('warns for unavailable optional reference sources without exposing tool error secrets', async () => {
  const tools = [
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'get_dashboards', inputSchema: { properties: {} } },
    { name: 'get_grafana_dashboards', inputSchema: { properties: {} } },
  ];
  const { oauth } = fakeOAuthClient(tools, {
    get_metric_names: ['http_requests_total'],
    get_dashboards: { dashboards: [] },
    get_grafana_dashboards: new Error('upstream rejected SENSITIVE_VALUE_DO_NOT_ECHO'),
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth, now: () => new Date('2026-07-15T00:00:00Z') },
  );

  await adapter.connect();
  const snapshot = await adapter.collect();

  assert.equal(snapshot.references.length, 0);
  assert.equal(snapshot.warnings.length, 4);
  assert.match(snapshot.warnings.join('\n'), /Grafana dashboard definitions/i);
  assert.match(snapshot.warnings.join('\n'), /alert definitions/i);
  assert.match(snapshot.warnings.join('\n'), /entity indicator queries/i);
  assert.match(snapshot.warnings.join('\n'), /PromQL query capability/i);
  assert.equal(snapshot.scrapeVolume, null);
  assert.doesNotMatch(snapshot.warnings.join('\n'), /SENSITIVE_VALUE_DO_NOT_ECHO/);
});

test('maps advertised inventory and per-entity indicator schemas without broadening access', async () => {
  const tools = [
    { name: 'prometheus_label_values', inputSchema: { required: ['label_name'], properties: { label_name: {} } } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
    { name: 'get_entity_indicators', inputSchema: { required: ['entity_id'], properties: { entity_id: {} } } },
  ];
  const { calls, oauth } = fakeOAuthClient(tools, {
    prometheus_label_values: { data: { result: [{ metric: { __name__: 'request_duration_seconds' } }] } },
    list_alert_rules: {
      rules: [
        { id: 'alert-1', name: 'Latency', expr: 'request_duration_seconds', entity_id: 'entity-a' },
        { id: 'alert-2', name: 'Latency sustained', expr: 'avg(request_duration_seconds)', entity_id: 'entity-a' },
        { id: 'alert-3', name: 'Latency other', expr: 'max(request_duration_seconds)', entity_id: 'entity-b' },
      ],
    },
    get_entity_indicators: ({ entity_id: entityId }) => [{
      id: `kpi-${entityId}`, name: 'Latency KPI', entity_name: entityId,
      definition: { query: 'histogram_quantile(0.99, request_duration_seconds)' },
    }],
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth, now: () => new Date('2026-07-15T00:00:00Z') },
  );

  await adapter.connect();
  const snapshot = await adapter.collect();

  assert.deepEqual(calls[0], { name: 'prometheus_label_values', args: { label_name: '__name__' } });
  assert.deepEqual(
    calls.filter(({ name }) => name === 'get_entity_indicators').map(({ args }) => args),
    [{ entity_id: 'entity-a' }, { entity_id: 'entity-b' }],
  );
  assert.deepEqual(snapshot.references.filter(({ kind }) => kind === 'indicator').map(({ sourceName }) => sourceName), [
    'entity-a > Latency KPI',
    'entity-b > Latency KPI',
  ]);
});

test('follows the Last9 dashboard detail and alert config response contracts', async () => {
  const tools = [
    {
      name: 'prometheus_label_values',
      inputSchema: { required: ['match_query', 'label'], properties: { match_query: {}, label: {}, lookback_minutes: {} } },
    },
    { name: 'list_dashboards', inputSchema: { properties: {} } },
    { name: 'get_dashboard', inputSchema: { required: ['id'], properties: { id: {}, region: {} } } },
    { name: 'get_alert_config', inputSchema: { properties: { search_term: {}, rule_name: {} } } },
    { name: 'get_alerts', inputSchema: { properties: {} } },
  ];
  const { calls, oauth } = fakeOAuthClient(tools, {
    prometheus_label_values: ['http_requests_total', 'queue_depth'],
    list_dashboards: [{ id: 'dashboard-1', name: 'Operations', metadata: { _type: 'metrics' } }],
    get_dashboard: {
      dashboard: {
        id: 'dashboard-1', name: 'Operations',
        panels: [{ name: 'Traffic', queries: [{ name: 'A', expr: 'sum(rate(http_requests_total[5m]))' }] }],
      },
    },
    get_alert_config: {
      text: [
        'Found 1 alert rules:',
        '',
        'Alert Rule 1:',
        '  ID: rule-1',
        '  Rule Name: Queue depth high',
        '  Indicators:',
        '    queue (KPI ID: kpi-1)',
        '      PromQL: max(queue_depth)',
        '  Updated: 2026-07-14 12:00:00 UTC',
      ].join('\n'),
    },
    get_alerts: new Error('firing alerts must not be queried for metric definitions'),
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth, now: () => new Date('2026-07-15T00:00:00Z') },
  );

  const connection = await adapter.connect();
  const snapshot = await adapter.collect();

  assert.deepEqual(connection.tools, [
    'prometheus_label_values', 'list_dashboards', 'get_dashboard', 'get_alert_config',
  ]);
  assert.deepEqual(calls, [
    { name: 'prometheus_label_values', args: { match_query: '{__name__!=""}', label: '__name__' } },
    { name: 'list_dashboards', args: {} },
    { name: 'get_dashboard', args: { id: 'dashboard-1' } },
    { name: 'get_alert_config', args: {} },
  ]);
  assert.deepEqual(snapshot.references, [
    {
      kind: 'dashboard', sourceId: 'dashboard-1', sourceName: 'Operations > Traffic > A',
      query: 'sum(rate(http_requests_total[5m]))', updatedAt: null,
    },
    {
      kind: 'alert', sourceId: 'rule-1', sourceName: 'Queue depth high',
      query: 'max(queue_depth)', updatedAt: '2026-07-14 12:00:00 UTC',
    },
  ]);
  assert.ok(calls.every(({ name }) => name !== 'get_alerts'));
});

test('fails closed when inventory or every reference capability is unavailable', async () => {
  const withoutInventory = fakeOAuthClient([
    { name: 'delete_metric_names' },
    { name: 'list_alert_rules' },
  ], {});
  const inventoryAdapter = new Last9MetricsAdapter(
    {},
    { oauth: withoutInventory.oauth },
  );
  await assert.rejects(inventoryAdapter.connect(), /read-only metric-name inventory capability/i);

  const withoutReferences = fakeOAuthClient([
    { name: 'get_metric_names' },
    { name: 'create_dashboards' },
    { name: 'delete_alert_rules' },
    { name: 'run_alert_rules', description: 'Run alert rule evaluation' },
  ], {});
  const referenceAdapter = new Last9MetricsAdapter(
    {},
    { oauth: withoutReferences.oauth },
  );
  await assert.rejects(referenceAdapter.connect(), /at least one read-only metric-reference capability/i);
});

test('rejects mutating, destructive, and unannotated suffix-compatible tools', async () => {
  const unsafeTools = [
    { name: 'reset_get_metric_names', annotations: { readOnlyHint: true } },
    { name: 'rotate_get_metric_names', annotations: { readOnlyHint: true } },
    { name: 'apply_get_metric_names', annotations: { readOnlyHint: true } },
    { name: 'tenant_get_metric_names' },
    { name: 'get_metric_names', annotations: { destructiveHint: true, readOnlyHint: true } },
    { name: 'list_alert_rules' },
  ];
  const unsafe = fakeOAuthClient(unsafeTools, {});
  const unsafeAdapter = new Last9MetricsAdapter(
    {},
    { oauth: unsafe.oauth },
  );

  await assert.rejects(unsafeAdapter.connect(), /read-only metric-name inventory capability/i);

  const safe = fakeOAuthClient([
    { name: 'tenant_get_metric_names', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    tenant_get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [] },
  });
  const safeAdapter = new Last9MetricsAdapter(
    {},
    { oauth: safe.oauth },
  );

  const connection = await safeAdapter.connect();
  assert.deepEqual(connection.tools, ['tenant_get_metric_names', 'list_alert_rules']);
});

test('fails closed when entity-scoped indicators cannot make a real reference request', async () => {
  const { calls, oauth } = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'get_entity_indicators', inputSchema: { required: ['entity_id'], properties: { entity_id: {} } } },
  ], {
    get_metric_names: ['http_requests_total'],
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth },
  );

  await adapter.connect();
  await assert.rejects(adapter.collect(), /No Last9 metric-reference capability completed successfully/i);
  assert.deepEqual(calls.map(({ name }) => name), ['get_metric_names']);
});

test('fails closed with sanitized errors for unusable inventory and failed reference reads', async () => {
  const inventoryFailure = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: new Error('SENSITIVE_INVENTORY_FAILURE'),
  });
  const inventoryAdapter = new Last9MetricsAdapter(
    {},
    { oauth: inventoryFailure.oauth },
  );
  await inventoryAdapter.connect();
  await assert.rejects(
    inventoryAdapter.collect(),
    (error) => /inventory could not be collected/i.test(error.message) && !/SENSITIVE_INVENTORY_FAILURE/.test(error.message),
  );

  const referenceFailure = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: new Error('SENSITIVE_REFERENCE_FAILURE'),
  });
  const referenceAdapter = new Last9MetricsAdapter(
    {},
    { oauth: referenceFailure.oauth },
  );
  await referenceAdapter.connect();
  await assert.rejects(
    referenceAdapter.collect(),
    (error) => /No Last9 metric-reference capability completed successfully/i.test(error.message)
      && !/SENSITIVE_REFERENCE_FAILURE/.test(error.message),
  );
});

test('collects aligned scrape-volume configuration evidence via the resolved PromQL query capability', async () => {
  const tools = [
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
    { name: 'prometheus_instant_query', annotations: { readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {}, time_iso: {}, lookback_minutes: {}, datasource: {} } } },
  ];
  const { calls, oauth } = fakeOAuthClient(tools, {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
    prometheus_instant_query: (args) => {
      if (args.query.startsWith('topk')) {
        return {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [
              { metric: { job: 'dynamo-svc' }, value: [1700000000, '213882'] },
              { metric: { job: 'api-svc' }, value: [1700000000, '151284'] },
            ],
          },
        };
      }
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { job: 'dynamo-svc' }, value: [1700000000, '60'] },
            { metric: { job: 'api-svc' }, value: [1700000000, '17'] },
          ],
        },
      };
    },
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth },
  );

  const connection = await adapter.connect();
  const snapshot = await adapter.collect();

  assert.ok(connection.tools.includes('prometheus_instant_query'));
  assert.deepEqual(snapshot.scrapeVolume, {
    targetsByJob: [{ job: 'dynamo-svc', targetCount: 60 }, { job: 'api-svc', targetCount: 17 }],
    samplesByJob: [{ job: 'dynamo-svc', samples: 213882 }, { job: 'api-svc', samples: 151284 }],
  });
  assert.equal(snapshot.warnings.length, 3);
  assert.doesNotMatch(snapshot.warnings.join('\n'), /PromQL query capability/i);
  assert.deepEqual(
    calls.filter(({ name }) => name === 'prometheus_instant_query').map(({ args }) => args.query),
    [
      'count by (job) (up) and on (job) topk(20, sum by (job) (scrape_samples_scraped))',
      'topk(20, sum by (job) (scrape_samples_scraped))',
    ],
  );
});

test('degrades to a warning, not a failure, when the PromQL query capability is absent or unusable', async () => {
  const withoutCapability = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
  });
  const adapterWithoutCapability = new Last9MetricsAdapter(
    {},
    { oauth: withoutCapability.oauth },
  );
  await adapterWithoutCapability.connect();
  const snapshotWithoutCapability = await adapterWithoutCapability.collect();
  assert.equal(snapshotWithoutCapability.scrapeVolume, null);
  assert.match(snapshotWithoutCapability.warnings.join('\n'), /PromQL query capability/i);

  const withFailingQuery = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
    { name: 'prometheus_instant_query', annotations: { readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {} } } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
    prometheus_instant_query: new Error('SENSITIVE_PROMETHEUS_FAILURE'),
  });
  const adapterWithFailingQuery = new Last9MetricsAdapter(
    {},
    { oauth: withFailingQuery.oauth },
  );
  await adapterWithFailingQuery.connect();
  const snapshotWithFailingQuery = await adapterWithFailingQuery.collect();
  assert.equal(snapshotWithFailingQuery.scrapeVolume, null);
  assert.doesNotMatch(snapshotWithFailingQuery.warnings.join('\n'), /SENSITIVE_PROMETHEUS_FAILURE/);
  assert.equal(snapshotWithFailingQuery.metricNames.length, 1);

  const withMalformedResult = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
    { name: 'prometheus_instant_query', annotations: { readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {} } } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
    prometheus_instant_query: { status: 'error', errorType: 'bad_data' },
  });
  const adapterWithMalformedResult = new Last9MetricsAdapter(
    {},
    { oauth: withMalformedResult.oauth },
  );
  await adapterWithMalformedResult.connect();
  const snapshotWithMalformedResult = await adapterWithMalformedResult.collect();
  assert.equal(snapshotWithMalformedResult.scrapeVolume, null);
  assert.match(snapshotWithMalformedResult.warnings.join('\n'), /unrecognized response shape/i);
});

test('keeps oversized optional scrape-volume query results fail-open', async () => {
  const oversizedResults = [
    Array.from({ length: 201 }, (_, index) => ({
      metric: { job: `job-${index}` },
      value: [1700000000, '1'],
    })),
    [{ metric: { job: `oversized-${'x'.repeat(1025)}` }, value: [1700000000, '1'] }],
  ];

  for (const oversizedResult of oversizedResults) {
    const { oauth } = fakeOAuthClient([
      { name: 'get_metric_names', inputSchema: { properties: {} } },
      { name: 'list_alert_rules', inputSchema: { properties: {} } },
      { name: 'prometheus_instant_query', annotations: { readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {} } } },
    ], {
      get_metric_names: ['http_requests_total'],
      list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
      prometheus_instant_query: (args) => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: args.query.startsWith('count by')
            ? oversizedResult
            : [{ metric: { job: 'api-svc' }, value: [1700000000, '151284'] }],
        },
      }),
    });
    const adapter = new Last9MetricsAdapter(
      {},
      { oauth },
    );

    await adapter.connect();
    const snapshot = await adapter.collect();

    assert.equal(snapshot.scrapeVolume, null);
    assert.equal(snapshot.metricNames.length, 1);
    assert.match(snapshot.warnings.join('\n'), /exceeded safe analysis bounds/i);
    assert.doesNotMatch(snapshot.warnings.join('\n'), /oversized-|job-200/i);
  }
});

test('rejects a PromQL query tool that is mutating, destructive, or missing the readOnlyHint annotation', async () => {
  const tools = [
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
    { name: 'update_prometheus_instant_query', annotations: { readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {} } } },
    { name: 'prometheus_instant_query', annotations: { destructiveHint: true, readOnlyHint: true }, inputSchema: { required: ['query'], properties: { query: {} } } },
  ];
  const { oauth } = fakeOAuthClient(tools, {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'http_requests_total' }] },
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth },
  );

  const connection = await adapter.connect();
  assert.ok(!connection.tools.includes('update_prometheus_instant_query'));
  assert.ok(!connection.tools.includes('prometheus_instant_query'));
  const snapshot = await adapter.collect();
  assert.equal(snapshot.scrapeVolume, null);
});

test('fails closed when metric inventory exceeds the advertised local result bound', async () => {
  const { oauth } = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: { limit: {} } } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: Array.from({ length: 1001 }, (_, index) => `metric_${index}`),
    list_alert_rules: { rules: [] },
  });
  const adapter = new Last9MetricsAdapter(
    {},
    { oauth },
  );

  await adapter.connect();
  await assert.rejects(
    adapter.collect(),
    (error) => /metric usage response exceeded safe analysis bounds/i.test(error.message)
      && !/metric_1000/.test(error.message),
  );
});

test('fails closed when normalized references or evidence strings exceed local bounds', async () => {
  const oversizedReferences = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: {
      rules: Array.from({ length: 4001 }, (_, index) => ({
        id: `alert-${index}`,
        expr: 'http_requests_total',
      })),
    },
  });
  const referencesAdapter = new Last9MetricsAdapter(
    {},
    { oauth: oversizedReferences.oauth },
  );
  await referencesAdapter.connect();
  await assert.rejects(referencesAdapter.collect(), /metric usage response exceeded safe analysis bounds/i);

  const oversizedQuery = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', expr: 'x'.repeat(16385) }] },
  });
  const queryAdapter = new Last9MetricsAdapter(
    {},
    { oauth: oversizedQuery.oauth },
  );
  await queryAdapter.connect();
  await assert.rejects(
    queryAdapter.collect(),
    (error) => /metric usage response exceeded safe analysis bounds/i.test(error.message)
      && !/xxxx/.test(error.message),
  );

  const oversizedSource = fakeOAuthClient([
    { name: 'get_metric_names', inputSchema: { properties: {} } },
    { name: 'list_alert_rules', inputSchema: { properties: {} } },
  ], {
    get_metric_names: ['http_requests_total'],
    list_alert_rules: { rules: [{ id: 'alert-1', name: 's'.repeat(1025), expr: 'http_requests_total' }] },
  });
  const sourceAdapter = new Last9MetricsAdapter(
    {},
    { oauth: oversizedSource.oauth },
  );
  await sourceAdapter.connect();
  await assert.rejects(
    sourceAdapter.collect(),
    (error) => /metric usage response exceeded safe analysis bounds/i.test(error.message)
      && !/ssss/.test(error.message),
  );
});
