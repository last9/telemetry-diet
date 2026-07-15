import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeMetricUsage,
  filterMetricUsage,
  renderMetricUsageJson,
  renderMetricUsageMarkdown,
  sortMetricUsage,
} from '../src/metric-usage/index.js';

function fixtureReport() {
  return analyzeMetricUsage({
    metricNames: ['app_errors_total', 'app_requests_total', 'node_cpu_seconds_total'],
    references: [
      {
        kind: 'dashboard',
        sourceId: 'dashboard-1',
        sourceName: 'Overview | Errors',
        query: 'app_errors_total',
        updatedAt: '2026-07-15T01:00:00Z',
      },
    ],
    warnings: ['Alert references were not available.'],
  });
}

test('filters and sorting expose actionable rows without mutating the report', () => {
  const report = fixtureReport();
  const originalNames = report.metrics.map(({ name }) => name);
  const filtered = filterMetricUsage(report.metrics, {
    statuses: ['unreferenced', 'underreferenced'],
    includeProtected: false,
    prefix: 'app_',
  });
  const sorted = sortMetricUsage(filtered, { by: 'referenceCount', direction: 'desc' });

  assert.deepEqual(sorted.map(({ name }) => name), ['app_errors_total', 'app_requests_total']);
  assert.deepEqual(report.metrics.map(({ name }) => name), originalNames);
});

test('Markdown and JSON reports preserve limitations and source provenance', () => {
  const report = fixtureReport();
  const markdown = renderMetricUsageMarkdown(report);
  const json = JSON.parse(renderMetricUsageJson(report));

  assert.match(markdown, /# Metric usage report/);
  assert.match(markdown, /unreferenced in scanned sources/i);
  assert.match(markdown, /Alert references were not available/);
  assert.match(markdown, /Overview \\| Errors/);
  assert.equal(json.metrics[0].locations[0].sourceId, 'dashboard-1');
  assert.deepEqual(json.summary, report.summary);
});
