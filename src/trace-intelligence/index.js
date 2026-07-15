import {
  createTraceIntelligenceArtifacts,
  TRACE_INTELLIGENCE_LIMITATIONS,
} from './artifacts.js';
import { normalizeHighCardinalitySpanName } from './span-name-patterns.js';
import { exactHealthRoute } from './trace-candidates.js';

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function measuredNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function scopeName(aggregate) {
  const scope = aggregate.instrumentationScope;
  return typeof scope === 'string' ? scope : String(scope?.name || 'unknown');
}

const PROTECTED_RESOURCE_ATTRIBUTES = new Set([
  'deployment.environment',
  'deployment.environment.name',
  'service.instance.id',
  'service.name',
  'service.namespace',
  'telemetry.sdk.language',
  'telemetry.sdk.name',
  'telemetry.sdk.version',
]);

function resourceTrimRecommendations(aggregates) {
  const attributes = new Map();

  for (const aggregate of aggregates) {
    if (!Array.isArray(aggregate.resourceAttributes)) continue;
    for (const attribute of aggregate.resourceAttributes) {
      const key = String(attribute.key || '');
      if (!key) continue;
      const current = attributes.get(key) || {
        safeToTrim: true,
        measuredBytes: 0,
        unmeasuredByteCount: 0,
        observedSpanCount: 0,
      };
      current.safeToTrim = current.safeToTrim && attribute.safeToTrim === true;
      const bytes = measuredNumber(attribute.bytes);
      if (bytes === null) current.unmeasuredByteCount += 1;
      else current.measuredBytes += bytes;
      current.observedSpanCount += number(aggregate.count);
      attributes.set(key, current);
    }
  }

  return [...attributes.entries()]
    .filter(([key, evidence]) => (
      evidence.safeToTrim
      && evidence.measuredBytes > 0
      && !PROTECTED_RESOURCE_ATTRIBUTES.has(key)
    ))
    .map(([key, evidence]) => {
      const measurementComplete = evidence.unmeasuredByteCount === 0;
      const measuredBytes = measurementComplete ? evidence.measuredBytes : null;
      return {
        id: `resource-attribute-trim.${key}`,
        category: 'resource-attribute-trim',
        target: { resourceAttribute: key },
        evidence: {
          measuredBytes,
          observedSpanCount: evidence.observedSpanCount,
        },
        estimatedByteReduction: measuredBytes,
        estimatedSpanReduction: 0,
        estimateBasis: measurementComplete
          ? 'measured-attribute-bytes'
          : 'attribute-byte-measurement-incomplete',
        preserves: ['span records', 'SERVER and CLIENT spans', 'error-bearing spans'],
        requiresReview: true,
      };
    })
    .sort((left, right) => (
      right.estimatedByteReduction - left.estimatedByteReduction
      || left.id.localeCompare(right.id)
    ));
}

function retainedAggregatePriority(left, right) {
  const priority = { SERVER: 0, CLIENT: 1 };
  const leftKind = String(left.spanKind || 'UNSPECIFIED').toUpperCase();
  const rightKind = String(right.spanKind || 'UNSPECIFIED').toUpperCase();
  return (priority[leftKind] ?? 2) - (priority[rightKind] ?? 2)
    || leftKind.localeCompare(rightKind)
    || String(left.spanName || 'unknown').localeCompare(String(right.spanName || 'unknown'));
}

function redundantInstrumentationRecommendations(aggregates) {
  const retainedByScope = new Map();
  for (const aggregate of aggregates) {
    const scope = scopeName(aggregate);
    const current = retainedByScope.get(scope);
    if (!current || retainedAggregatePriority(aggregate, current) < 0) retainedByScope.set(scope, aggregate);
  }

  return aggregates.flatMap((aggregate) => {
    const retainedScope = typeof aggregate.redundantWith === 'string'
      ? aggregate.redundantWith
      : '';
    const kind = String(aggregate.spanKind || 'UNSPECIFIED').toUpperCase();
    const name = String(aggregate.spanName || 'unknown');
    const scope = scopeName(aggregate);
    const retained = retainedByScope.get(retainedScope);

    if (
      !retainedScope
      || retained === undefined
      || number(aggregate.errorCount) > 0
      || aggregate.businessSpan === true
    ) return [];

    const measuredBytes = measuredNumber(aggregate.bytes);

    return [{
      id: `redundant-instrumentation.${scope}.${kind}.${encodeURIComponent(name)}`,
      category: 'redundant-instrumentation-disablement',
      target: {
        instrumentationScope: scope,
        spanKind: kind,
        spanName: name,
        retainInstrumentationScope: retainedScope,
      },
      evidence: {
        measuredBytes,
        observedSpanCount: number(aggregate.count),
      },
      estimatedByteReduction: measuredBytes,
      estimatedSpanReduction: number(aggregate.count),
      estimateBasis: measuredBytes === null ? 'span-count-only' : 'measured-aggregate-bytes',
      preserves: [
        `${String(retained.spanKind || 'UNSPECIFIED').toUpperCase()} span from ${retainedScope}`,
        'error-bearing spans',
      ],
      requiresReview: true,
    }];
  });
}

function lowValueLeafRecommendations(aggregates) {
  return aggregates.flatMap((aggregate) => {
    const kind = String(aggregate.spanKind || 'UNSPECIFIED').toUpperCase();
    if (
      kind !== 'INTERNAL'
      || aggregate.leaf !== true
      || aggregate.lowValue !== true
      || aggregate.businessSpan === true
      || number(aggregate.errorCount) > 0
    ) return [];

    const name = String(aggregate.spanName || 'unknown');
    const scope = scopeName(aggregate);
    const measuredBytes = measuredNumber(aggregate.bytes);
    return [{
      id: `low-value-leaf.${scope}.${encodeURIComponent(name)}`,
      category: 'selective-low-value-leaf-filter',
      target: {
        instrumentationScope: scope,
        spanKind: kind,
        spanName: name,
      },
      evidence: {
        measuredBytes,
        observedSpanCount: number(aggregate.count),
      },
      estimatedByteReduction: measuredBytes,
      estimatedSpanReduction: number(aggregate.count),
      estimateBasis: measuredBytes === null ? 'span-count-only' : 'measured-aggregate-bytes',
      preserves: ['SERVER and CLIENT spans', 'error-bearing spans', 'business spans'],
      requiresReview: true,
    }];
  });
}

function spanNameNormalizationRecommendations(aggregates) {
  const groups = new Map();

  for (const aggregate of aggregates) {
    const spanName = String(aggregate.spanName || 'unknown');
    const normalized = normalizeHighCardinalitySpanName(spanName);
    if (!normalized.changed) continue;

    const kind = String(aggregate.spanKind || 'UNSPECIFIED').toUpperCase();
    const scope = scopeName(aggregate);
    if (scope === 'unknown') continue;
    const key = `${scope}\u0000${kind}\u0000${normalized.normalizedSpanName}`;
    const current = groups.get(key) || {
      scope,
      kind,
      normalizedSpanName: normalized.normalizedSpanName,
      patterns: new Set(),
      originalNames: new Set(),
      observedSpanCount: 0,
      measuredBytes: 0,
      byteMeasurementComplete: true,
    };
    normalized.patterns.forEach((pattern) => current.patterns.add(pattern));
    current.originalNames.add(spanName);
    current.observedSpanCount += number(aggregate.count);
    const bytes = measuredNumber(aggregate.bytes);
    if (bytes === null) current.byteMeasurementComplete = false;
    else current.measuredBytes += bytes;
    groups.set(key, current);
  }

  return [...groups.values()].flatMap((group) => {
    if (group.originalNames.size < 2) return [];
    return [{
      id: `span-name-normalization.${group.scope}.${group.kind}.${encodeURIComponent(group.normalizedSpanName)}`,
      category: 'span-name-normalization',
      target: {
        instrumentationScope: group.scope,
        spanKind: group.kind,
        normalizedSpanName: group.normalizedSpanName,
        patterns: [...group.patterns].sort(),
      },
      evidence: {
        distinctSpanNames: group.originalNames.size,
        observedSpanCount: group.observedSpanCount,
        measuredBytes: group.byteMeasurementComplete ? group.measuredBytes : null,
      },
      estimatedByteReduction: null,
      estimatedSpanReduction: 0,
      estimateBasis: 'cardinality-reduction-not-an-export-byte-estimate',
      preserves: ['span records', 'span kinds', 'error-bearing spans'],
      requiresReview: true,
    }];
  });
}

function healthRouteRecommendations(aggregates) {
  return aggregates.flatMap((aggregate) => {
    const httpRoute = exactHealthRoute(aggregate.httpRoute);
    if (!httpRoute) return [];

    const spanKind = String(aggregate.spanKind || 'UNSPECIFIED').toUpperCase();
    const instrumentationScope = scopeName(aggregate);
    const spanName = String(aggregate.spanName || 'unknown');
    const measuredBytes = measuredNumber(aggregate.bytes);
    const errorCount = measuredNumber(aggregate.errorCount);
    const draftEligible = spanKind === 'INTERNAL'
      && aggregate.leaf === true
      && aggregate.businessSpan !== true
      && errorCount === 0;

    return [{
      id: `health-route.${instrumentationScope}.${spanKind}.${encodeURIComponent(httpRoute)}.${encodeURIComponent(spanName)}`,
      category: 'health-route-candidate',
      target: {
        httpRoute,
        instrumentationScope,
        spanKind,
        spanName,
        draftEligible,
      },
      evidence: {
        measuredBytes,
        observedSpanCount: number(aggregate.count),
        errorCount,
      },
      estimatedByteReduction: null,
      estimatedSpanReduction: 0,
      estimateBasis: 'candidate-not-an-export-byte-estimate',
      preserves: [
        'error-bearing spans',
        'business spans',
        'SERVER and CLIENT spans in generated drafts',
      ],
      requiresReview: true,
      caveats: [
        'Health traffic can carry availability signals; validate monitoring coverage before rollout.',
      ],
    }];
  });
}

function fastSuccessRecommendations(aggregates, configuration) {
  const maxAverageDurationMs = measuredNumber(configuration?.maxAverageDurationMs);
  if (maxAverageDurationMs === null || maxAverageDurationMs <= 0) return [];

  return aggregates.flatMap((aggregate) => {
    const averageDurationMs = measuredNumber(aggregate.averageDurationMs);
    const errorCount = measuredNumber(aggregate.errorCount);
    if (
      averageDurationMs === null
      || averageDurationMs > maxAverageDurationMs
      || errorCount === null
      || errorCount > 0
      || aggregate.businessSpan === true
      || number(aggregate.count) === 0
    ) return [];

    const instrumentationScope = scopeName(aggregate);
    const spanKind = String(aggregate.spanKind || 'UNSPECIFIED').toUpperCase();
    const spanName = String(aggregate.spanName || 'unknown');
    return [{
      id: `fast-success.${instrumentationScope}.${spanKind}.${encodeURIComponent(spanName)}`,
      category: 'fast-success-cohort',
      target: {
        instrumentationScope,
        spanKind,
        spanName,
        maxAverageDurationMs,
      },
      evidence: {
        averageDurationMs,
        observedSpanCount: number(aggregate.count),
        measuredBytes: measuredNumber(aggregate.bytes),
        errorCount,
      },
      estimatedByteReduction: null,
      estimatedSpanReduction: null,
      estimateBasis: 'sampling-candidate-not-an-exact-savings-estimate',
      preserves: ['no generated drop rule', 'error-bearing spans excluded from the cohort'],
      requiresReview: true,
      caveats: [
        'Validate complete-trace latency and error retention before defining a sampling policy.',
      ],
    }];
  });
}

function residualHeadSamplingRecommendation(aggregates, configuration) {
  const ratio = Number(configuration?.ratio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return [];

  return [{
    id: 'residual-head-sampling',
    category: 'residual-head-sampling',
    target: { ratio },
    evidence: {
      measuredBytes: null,
      observedSpanCount: aggregates.reduce((sum, aggregate) => sum + number(aggregate.count), 0),
    },
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
  }];
}

function rankRecommendations(recommendations) {
  return recommendations.sort((left, right) => (
    Number(left.category === 'residual-head-sampling') - Number(right.category === 'residual-head-sampling')
    || number(right.estimatedByteReduction) - number(left.estimatedByteReduction)
    || number(right.estimatedSpanReduction) - number(left.estimatedSpanReduction)
    || left.id.localeCompare(right.id)
  ));
}

export function analyzeTraceIntelligence(input = {}) {
  const aggregates = Array.isArray(input.aggregates) ? input.aggregates : [];
  const byteMeasurements = aggregates.map(({ bytes }) => measuredNumber(bytes));
  const measuredBytes = byteMeasurements.reduce((sum, bytes) => sum + (bytes ?? 0), 0);
  const measuredAggregateCount = byteMeasurements.filter((bytes) => bytes !== null).length;
  const unmeasuredAggregateCount = aggregates.length - measuredAggregateCount;
  const byteMeasurementComplete = unmeasuredAggregateCount === 0;
  const resourceAttributeKeys = aggregates.flatMap((aggregate) => (
    Array.isArray(aggregate.resourceAttributes)
      ? aggregate.resourceAttributes.map(({ key }) => String(key))
      : Object.keys(aggregate.resourceAttributes || {})
  ));

  const recommendations = rankRecommendations([
    ...resourceTrimRecommendations(aggregates),
    ...spanNameNormalizationRecommendations(aggregates),
    ...healthRouteRecommendations(aggregates),
    ...fastSuccessRecommendations(aggregates, input.fastSuccessCandidates),
    ...redundantInstrumentationRecommendations(aggregates),
    ...lowValueLeafRecommendations(aggregates),
    ...residualHeadSamplingRecommendation(aggregates, input.residualHeadSampling),
  ]);

  return {
    summary: {
      aggregateCount: aggregates.length,
      measuredBytes,
      measuredAggregateCount,
      unmeasuredAggregateCount,
      byteMeasurementComplete,
      totalBytes: byteMeasurementComplete ? measuredBytes : null,
      totalSpans: aggregates.reduce((sum, aggregate) => sum + number(aggregate.count), 0),
      totalErrors: aggregates.reduce((sum, aggregate) => sum + number(aggregate.errorCount), 0),
      spanKinds: uniqueSorted(aggregates.map(({ spanKind }) => String(spanKind || 'UNSPECIFIED').toUpperCase())),
      spanNames: uniqueSorted(aggregates.map(({ spanName }) => String(spanName || 'unknown'))),
      instrumentationScopes: uniqueSorted(aggregates.map(scopeName)),
      resourceAttributeKeys: uniqueSorted(resourceAttributeKeys),
    },
    recommendations,
    artifacts: createTraceIntelligenceArtifacts(recommendations),
    limitations: [...TRACE_INTELLIGENCE_LIMITATIONS],
  };
}
