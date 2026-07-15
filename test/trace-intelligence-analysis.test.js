import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeTraceIntelligence } from '../src/trace-intelligence/index.js';

const normalizedTraceInput = {
  aggregates: [
    {
      spanKind: 'SERVER',
      spanName: 'GET /orders',
      instrumentationScope: 'http.server',
      resourceAttributes: [
        { key: 'service.name', bytes: 120 },
        { key: 'host.id', bytes: 480 },
      ],
      bytes: 1_200,
      count: 10,
      errorCount: 1,
    },
    {
      spanKind: 'INTERNAL',
      spanName: 'serialize response',
      instrumentationScope: 'response.serializer',
      resourceAttributes: [{ key: 'service.name', bytes: 60 }],
      bytes: 300,
      count: 5,
      errorCount: 0,
      leaf: true,
    },
  ],
};

test('trace analysis is deterministic and summarizes every normalized dimension', () => {
  const first = analyzeTraceIntelligence(normalizedTraceInput);
  const second = analyzeTraceIntelligence(normalizedTraceInput);

  assert.deepEqual(first, second);
  assert.deepEqual(first.summary, {
    aggregateCount: 2,
    measuredBytes: 1_500,
    measuredAggregateCount: 2,
    unmeasuredAggregateCount: 0,
    byteMeasurementComplete: true,
    totalBytes: 1_500,
    totalSpans: 15,
    totalErrors: 1,
    spanKinds: ['INTERNAL', 'SERVER'],
    spanNames: ['GET /orders', 'serialize response'],
    instrumentationScopes: ['http.server', 'response.serializer'],
    resourceAttributeKeys: ['host.id', 'service.name'],
  });
});

test('missing byte measurements remain unknown without invalidating span counts', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'CLIENT', spanName: 'SELECT orders', instrumentationScope: 'db.client',
        bytes: 500, count: 10, errorCount: 0,
      },
      {
        spanKind: 'INTERNAL', spanName: 'database wrapper', instrumentationScope: 'manual.db.wrapper',
        count: 10, errorCount: 0, redundantWith: 'db.client',
      },
      {
        spanKind: 'INTERNAL', spanName: 'encode payload', instrumentationScope: 'payload.encoder',
        bytes: null, count: 20, errorCount: 0, leaf: true, lowValue: true,
      },
    ],
  });

  assert.equal(result.summary.measuredBytes, 500);
  assert.equal(result.summary.measuredAggregateCount, 1);
  assert.equal(result.summary.unmeasuredAggregateCount, 2);
  assert.equal(result.summary.byteMeasurementComplete, false);
  assert.equal(result.summary.totalBytes, null);
  assert.equal(result.summary.totalSpans, 40);

  const redundant = result.recommendations.find(({ category }) => (
    category === 'redundant-instrumentation-disablement'
  ));
  assert.equal(redundant.evidence.measuredBytes, null);
  assert.equal(redundant.estimatedByteReduction, null);
  assert.equal(redundant.estimateBasis, 'span-count-only');

  const leaf = result.recommendations.find(({ category }) => (
    category === 'selective-low-value-leaf-filter'
  ));
  assert.equal(leaf.evidence.measuredBytes, null);
  assert.equal(leaf.estimatedByteReduction, null);
  assert.equal(leaf.estimateBasis, 'span-count-only');
});

test('safe resource attribute trimming is ranked by measured byte reduction', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'SERVER',
        spanName: 'POST /checkout',
        instrumentationScope: 'http.server',
        bytes: 4_000,
        count: 20,
        errorCount: 2,
        resourceAttributes: [
          { key: 'service.name', bytes: 800, safeToTrim: true },
          { key: 'process.command_args', bytes: 1_500, safeToTrim: true },
          { key: 'host.id', bytes: 600, safeToTrim: false },
        ],
      },
    ],
  });

  assert.deepEqual(result.recommendations, [
    {
      id: 'resource-attribute-trim.process.command_args',
      category: 'resource-attribute-trim',
      target: { resourceAttribute: 'process.command_args' },
      evidence: {
        measuredBytes: 1_500,
        observedSpanCount: 20,
      },
      estimatedByteReduction: 1_500,
      estimatedSpanReduction: 0,
      estimateBasis: 'measured-attribute-bytes',
      preserves: ['span records', 'SERVER and CLIENT spans', 'error-bearing spans'],
      requiresReview: true,
    },
  ]);
});

test('resource attribute savings stay unknown when any matching byte measurement is absent', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'SERVER', spanName: 'GET /orders', instrumentationScope: 'http.server',
        bytes: 500, count: 10, errorCount: 0,
        resourceAttributes: [
          { key: 'process.command_args', bytes: 100, safeToTrim: true },
        ],
      },
      {
        spanKind: 'SERVER', spanName: 'GET /orders/:id', instrumentationScope: 'http.server',
        bytes: 500, count: 5, errorCount: 0,
        resourceAttributes: [
          { key: 'process.command_args', safeToTrim: true },
        ],
      },
    ],
  });

  assert.deepEqual(result.recommendations[0], {
    id: 'resource-attribute-trim.process.command_args',
    category: 'resource-attribute-trim',
    target: { resourceAttribute: 'process.command_args' },
    evidence: {
      measuredBytes: null,
      observedSpanCount: 15,
    },
    estimatedByteReduction: null,
    estimatedSpanReduction: 0,
    estimateBasis: 'attribute-byte-measurement-incomplete',
    preserves: ['span records', 'SERVER and CLIENT spans', 'error-bearing spans'],
    requiresReview: true,
  });
});

test('redundant instrumentation may wrap a retained span with a different kind and name', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'CLIENT', spanName: 'SELECT orders', instrumentationScope: 'db.client',
        bytes: 5_000, count: 100, errorCount: 2,
      },
      {
        spanKind: 'INTERNAL', spanName: 'database wrapper', instrumentationScope: 'manual.db.wrapper',
        bytes: 2_000, count: 100, errorCount: 0, redundantWith: 'db.client',
      },
      {
        spanKind: 'INTERNAL', spanName: 'database error wrapper', instrumentationScope: 'manual.db.errors',
        bytes: 2_500, count: 10, errorCount: 1, redundantWith: 'db.client',
      },
      {
        spanKind: 'INTERNAL', spanName: 'business transaction', instrumentationScope: 'manual.db.business',
        bytes: 3_000, count: 100, errorCount: 0, businessSpan: true, redundantWith: 'db.client',
      },
    ],
  });

  assert.deepEqual(result.recommendations, [
    {
      id: 'redundant-instrumentation.manual.db.wrapper.INTERNAL.database%20wrapper',
      category: 'redundant-instrumentation-disablement',
      target: {
        instrumentationScope: 'manual.db.wrapper',
        spanKind: 'INTERNAL',
        spanName: 'database wrapper',
        retainInstrumentationScope: 'db.client',
      },
      evidence: { measuredBytes: 2_000, observedSpanCount: 100 },
      estimatedByteReduction: 2_000,
      estimatedSpanReduction: 100,
      estimateBasis: 'measured-aggregate-bytes',
      preserves: ['CLIENT span from db.client', 'error-bearing spans'],
      requiresReview: true,
    },
  ]);
});

test('leaf filtering excludes SERVER, CLIENT, error-bearing, and business spans', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'INTERNAL', spanName: 'encode payload', instrumentationScope: 'payload.encoder',
        bytes: 900, count: 300, errorCount: 0, leaf: true, lowValue: true,
      },
      {
        spanKind: 'INTERNAL', spanName: 'validate order', instrumentationScope: 'domain.rules',
        bytes: 1_800, count: 300, errorCount: 0, leaf: true, lowValue: true, businessSpan: true,
      },
      {
        spanKind: 'INTERNAL', spanName: 'cache lookup', instrumentationScope: 'cache.client',
        bytes: 1_500, count: 300, errorCount: 3, leaf: true, lowValue: true,
      },
      {
        spanKind: 'SERVER', spanName: 'GET /orders', instrumentationScope: 'http.server',
        bytes: 2_000, count: 300, errorCount: 0, leaf: true, lowValue: true,
      },
      {
        spanKind: 'CLIENT', spanName: 'SELECT orders', instrumentationScope: 'db.client',
        bytes: 2_500, count: 300, errorCount: 0, leaf: true, lowValue: true,
      },
    ],
  });

  assert.deepEqual(result.recommendations, [
    {
      id: 'low-value-leaf.payload.encoder.encode%20payload',
      category: 'selective-low-value-leaf-filter',
      target: {
        instrumentationScope: 'payload.encoder',
        spanKind: 'INTERNAL',
        spanName: 'encode payload',
      },
      evidence: { measuredBytes: 900, observedSpanCount: 300 },
      estimatedByteReduction: 900,
      estimatedSpanReduction: 300,
      estimateBasis: 'measured-aggregate-bytes',
      preserves: ['SERVER and CLIENT spans', 'error-bearing spans', 'business spans'],
      requiresReview: true,
    },
  ]);
});

test('high-cardinality span names produce a redacted normalization candidate', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'SERVER',
        spanName: 'GET /orders/6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        instrumentationScope: 'http.server',
        bytes: 1_200,
        count: 20,
        errorCount: 0,
      },
      {
        spanKind: 'SERVER',
        spanName: 'GET /orders/6ba7b811-9dad-11d1-80b4-00c04fd430c8',
        instrumentationScope: 'http.server',
        bytes: 900,
        count: 15,
        errorCount: 0,
      },
    ],
  });

  const recommendation = result.recommendations.find(({ category }) => (
    category === 'span-name-normalization'
  ));
  assert.deepEqual(recommendation, {
    id: 'span-name-normalization.http.server.SERVER.GET%20%2Forders%2F%7Buuid%7D',
    category: 'span-name-normalization',
    target: {
      instrumentationScope: 'http.server',
      spanKind: 'SERVER',
      normalizedSpanName: 'GET /orders/{uuid}',
      patterns: ['uuid'],
    },
    evidence: {
      distinctSpanNames: 2,
      observedSpanCount: 35,
      measuredBytes: 2_100,
    },
    estimatedByteReduction: null,
    estimatedSpanReduction: 0,
    estimateBasis: 'cardinality-reduction-not-an-export-byte-estimate',
    preserves: ['span records', 'span kinds', 'error-bearing spans'],
    requiresReview: true,
  });
  assert.doesNotMatch(JSON.stringify(recommendation), /6ba7b81/);
});

test('normalization covers long opaque identifiers but ignores stable numeric names', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'INTERNAL', spanName: 'process job aabbccddeeff00112233445566778899',
        instrumentationScope: 'jobs.worker', count: 10, errorCount: 0,
      },
      {
        spanKind: 'INTERNAL', spanName: 'process job 11223344556677889900aabbccddeeff',
        instrumentationScope: 'jobs.worker', count: 12, errorCount: 0,
      },
      {
        spanKind: 'INTERNAL', spanName: 'HTTP 200',
        instrumentationScope: 'http.status', count: 100, errorCount: 0,
      },
    ],
  });

  const normalizations = result.recommendations.filter(({ category }) => (
    category === 'span-name-normalization'
  ));
  assert.equal(normalizations.length, 1);
  assert.equal(normalizations[0].target.normalizedSpanName, 'process job {hex}');
  assert.deepEqual(normalizations[0].target.patterns, ['hex']);
  assert.doesNotMatch(JSON.stringify(normalizations), /aabbccdd|11223344/);
});

test('health routes are reported without making protected spans draft-eligible', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'SERVER', spanName: 'GET /healthz', httpRoute: '/healthz',
        instrumentationScope: 'http.server', bytes: 2_000, count: 400, errorCount: 0,
      },
      {
        spanKind: 'INTERNAL', spanName: 'health response encoder', httpRoute: '/healthz',
        instrumentationScope: 'response.encoder', bytes: 600, count: 400, errorCount: 0,
        leaf: true,
      },
      {
        spanKind: 'INTERNAL', spanName: 'readiness business check', httpRoute: '/readyz',
        instrumentationScope: 'domain.health', bytes: 800, count: 100, errorCount: 0,
        leaf: true, businessSpan: true,
      },
    ],
  });

  const candidates = result.recommendations.filter(({ category }) => (
    category === 'health-route-candidate'
  ));
  assert.deepEqual(candidates.map(({ target }) => target).sort((left, right) => (
    left.instrumentationScope.localeCompare(right.instrumentationScope)
  )), [
    {
      httpRoute: '/readyz', instrumentationScope: 'domain.health', spanKind: 'INTERNAL',
      spanName: 'readiness business check', draftEligible: false,
    },
    {
      httpRoute: '/healthz', instrumentationScope: 'http.server', spanKind: 'SERVER',
      spanName: 'GET /healthz', draftEligible: false,
    },
    {
      httpRoute: '/healthz', instrumentationScope: 'response.encoder', spanKind: 'INTERNAL',
      spanName: 'health response encoder', draftEligible: true,
    },
  ]);
  assert.ok(candidates.every(({ estimatedByteReduction, estimatedSpanReduction }) => (
    estimatedByteReduction === null && estimatedSpanReduction === 0
  )));
});

test('health-route candidates preserve the exact observed route for generated matches', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [{
      spanKind: 'INTERNAL', spanName: 'health response encoder', httpRoute: '/HealthZ',
      instrumentationScope: 'response.encoder', count: 10, errorCount: 0, leaf: true,
    }],
  });

  const candidate = result.recommendations.find(({ category }) => (
    category === 'health-route-candidate'
  ));
  assert.equal(candidate.target.httpRoute, '/HealthZ');
  assert.match(result.artifacts[1].content, /http\.route"\] == "\/HealthZ"/);
});

test('health routes with missing error evidence remain review-only', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [{
      spanKind: 'INTERNAL', spanName: 'liveness response encoder', httpRoute: '/livez',
      instrumentationScope: 'response.encoder', count: 10, leaf: true,
    }],
  });

  const candidate = result.recommendations.find(({ category }) => (
    category === 'health-route-candidate'
  ));
  assert.equal(candidate.target.draftEligible, false);
  assert.equal(candidate.evidence.errorCount, null);
  assert.doesNotMatch(result.artifacts[1].content, /drop\(\)/);
});

test('fast successful cohorts require an explicit measured-duration threshold', () => {
  const aggregates = [
    {
      spanKind: 'INTERNAL', spanName: 'encode response', instrumentationScope: 'response.encoder',
      bytes: 900, count: 300, errorCount: 0, averageDurationMs: 4.5, leaf: true,
    },
    {
      spanKind: 'INTERNAL', spanName: 'occasionally failing cache lookup', instrumentationScope: 'cache.client',
      bytes: 1_200, count: 300, errorCount: 2, averageDurationMs: 3.2, leaf: true,
    },
    {
      spanKind: 'SERVER', spanName: 'GET /orders', instrumentationScope: 'http.server',
      bytes: 2_000, count: 300, errorCount: 0, averageDurationMs: 25,
    },
    {
      spanKind: 'INTERNAL', spanName: 'missing error evidence', instrumentationScope: 'unknown.errors',
      bytes: 500, count: 50, averageDurationMs: 2, leaf: true,
    },
  ];

  assert.equal(analyzeTraceIntelligence({ aggregates }).recommendations.some(({ category }) => (
    category === 'fast-success-cohort'
  )), false);

  const result = analyzeTraceIntelligence({
    aggregates,
    fastSuccessCandidates: { maxAverageDurationMs: 10 },
  });
  const candidates = result.recommendations.filter(({ category }) => (
    category === 'fast-success-cohort'
  ));
  assert.deepEqual(candidates, [{
    id: 'fast-success.response.encoder.INTERNAL.encode%20response',
    category: 'fast-success-cohort',
    target: {
      instrumentationScope: 'response.encoder',
      spanKind: 'INTERNAL',
      spanName: 'encode response',
      maxAverageDurationMs: 10,
    },
    evidence: {
      averageDurationMs: 4.5,
      observedSpanCount: 300,
      measuredBytes: 900,
      errorCount: 0,
    },
    estimatedByteReduction: null,
    estimatedSpanReduction: null,
    estimateBasis: 'sampling-candidate-not-an-exact-savings-estimate',
    preserves: ['no generated drop rule', 'error-bearing spans excluded from the cohort'],
    requiresReview: true,
    caveats: ['Validate complete-trace latency and error retention before defining a sampling policy.'],
  }]);
});

test('residual head sampling is last and does not claim exact savings', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'INTERNAL', spanName: 'encode payload', instrumentationScope: 'payload.encoder',
        bytes: 900, count: 300, errorCount: 0, leaf: true, lowValue: true,
      },
    ],
    residualHeadSampling: { ratio: 0.25 },
  });

  assert.deepEqual(result.recommendations.at(-1), {
    id: 'residual-head-sampling',
    category: 'residual-head-sampling',
    target: { ratio: 0.25 },
    evidence: { measuredBytes: null, observedSpanCount: 300 },
    estimatedByteReduction: null,
    estimatedSpanReduction: null,
    estimateBasis: 'probabilistic-not-an-exact-savings-estimate',
    preserves: ['explicit error-retention policy required'],
    requiresReview: true,
    caveats: [
      'Head sampling can reduce APM visibility for unsampled traces.',
      'Errors are not guaranteed to remain visible unless the sampling policy explicitly retains them.',
      'Validate the ratio against measured exported bytes and trace completeness before rollout.',
    ],
  });
});
