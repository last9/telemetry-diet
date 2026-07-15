import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeMetricUsage,
  extractMetricNames,
  PromQlParseError,
} from '../src/metric-usage/index.js';

test('PromQL extraction follows nested AST selectors without treating labels or functions as metrics', () => {
  const metrics = extractMetricNames(
    'histogram_quantile(0.95, sum by (le) (rate(request_duration_seconds_bucket[5m]))) '
      + '/ on(job) group_left service:request_target',
  );

  assert.deepEqual(metrics, [
    'request_duration_seconds_bucket',
    'service:request_target',
  ]);
});

test('PromQL extraction includes exact __name__ label matchers', () => {
  const metrics = extractMetricNames(
    '{__name__="request_duration_seconds", service="api"} '
      + '+ sum(rate(another_metric_total[5m]))',
  );

  assert.deepEqual(metrics, [
    'request_duration_seconds',
    'another_metric_total',
  ]);
});

test('dynamic __name__ matchers fail closed with an explicit report limitation', () => {
  const dynamicQuery = '{__name__=~"request_.+"}';

  assert.throws(
    () => extractMetricNames(dynamicQuery),
    (error) => error instanceof PromQlParseError
      && /dynamic/.test(error.message)
      && /metric catalog/.test(error.message),
  );

  const report = analyzeMetricUsage({
    metricNames: ['request_duration_seconds'],
    references: [
      {
        kind: 'dashboard',
        sourceId: 'dynamic-selector',
        sourceName: 'Dynamic selector',
        query: dynamicQuery,
        updatedAt: null,
      },
    ],
    warnings: [],
  });

  assert.deepEqual(report.unparsedQueries, [dynamicQuery]);
  assert.equal(report.metrics[0].status, 'unreferenced');
  assert.deepEqual(report.limitations, [
    'Dynamic __name__ matchers are not resolved; affected reference counts may be incomplete.',
  ]);
});

test('parse failures are deduplicated and partial AST results do not count as references', () => {
  const brokenQuery = 'sum(rate(partial_metric[5m])';
  const report = analyzeMetricUsage({
    metricNames: ['partial_metric'],
    references: [
      { kind: 'dashboard', sourceId: 'one', sourceName: 'One', query: brokenQuery, updatedAt: null },
      { kind: 'alert', sourceId: 'two', sourceName: 'Two', query: brokenQuery, updatedAt: null },
    ],
    warnings: [],
  });

  assert.deepEqual(report.unparsedQueries, [brokenQuery]);
  assert.equal(report.metrics[0].status, 'unreferenced');
  assert.equal(report.metrics[0].referenceCount, 0);
  assert.deepEqual(report.limitations, [
    'Some PromQL queries could not be parsed; reference counts may be incomplete.',
  ]);
});
