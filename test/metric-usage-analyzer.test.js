import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeMetricUsage } from '../src/metric-usage/index.js';

test('analysis keeps observed usage separate from protection policy', () => {
  const report = analyzeMetricUsage({
    metricNames: [
      'api_requests_total',
      'jobs_queued',
      'node_cpu_seconds_total',
    ],
    references: [
      {
        kind: 'dashboard',
        sourceId: 'dashboard-1',
        sourceName: 'Service overview > Request rate',
        query: 'sum(rate(api_requests_total[5m])) + api_requests_total',
        updatedAt: '2026-07-15T01:00:00Z',
      },
      {
        kind: 'alert',
        sourceId: 'alert-1',
        sourceName: 'Request volume',
        query: 'api_requests_total > 10',
        updatedAt: '2026-07-15T02:00:00Z',
      },
      {
        kind: 'indicator',
        sourceId: 'indicator-1',
        sourceName: 'Queue health',
        query: 'jobs_queued + recording_rule_metric',
        updatedAt: null,
      },
    ],
    warnings: ['Dashboard collection was incomplete.'],
  });

  assert.deepEqual(report.summary, {
    metricCount: 4,
    catalogCount: 3,
    referencedCount: 1,
    underreferencedCount: 2,
    unreferencedCount: 1,
    protectedCount: 1,
  });

  const byName = Object.fromEntries(report.metrics.map((metric) => [metric.name, metric]));
  assert.equal(byName.api_requests_total.status, 'referenced');
  assert.equal(byName.api_requests_total.referenceCount, 2);
  assert.equal(byName.api_requests_total.locations.length, 2);
  assert.equal(byName.jobs_queued.status, 'underreferenced');
  assert.equal(byName.recording_rule_metric.inCatalog, false);
  assert.equal(byName.recording_rule_metric.status, 'underreferenced');
  assert.equal(byName.node_cpu_seconds_total.status, 'unreferenced');
  assert.equal(byName.node_cpu_seconds_total.protected, true);
  assert.deepEqual(byName.jobs_queued.locations[0], {
    kind: 'indicator',
    sourceId: 'indicator-1',
    sourceName: 'Queue health',
    query: 'jobs_queued + recording_rule_metric',
    updatedAt: null,
  });
  assert.deepEqual(report.warnings, ['Dashboard collection was incomplete.']);
  assert.deepEqual(report.unparsedQueries, []);
});

test('strict mode disables protection without changing observed status', () => {
  const snapshot = {
    metricNames: ['node_cpu_seconds_total'],
    references: [],
    warnings: [],
  };

  const defaultReport = analyzeMetricUsage(snapshot);
  const strictReport = analyzeMetricUsage(snapshot, { protection: { enabled: false } });

  assert.equal(defaultReport.metrics[0].status, 'unreferenced');
  assert.equal(defaultReport.metrics[0].protected, true);
  assert.equal(strictReport.metrics[0].status, 'unreferenced');
  assert.equal(strictReport.metrics[0].protected, false);
});
