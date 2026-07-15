function literal(value) {
  return JSON.stringify(String(value));
}

function yamlExpression(expression) {
  return `'${expression.replaceAll("'", "''")}'`;
}

export const TRACE_INTELLIGENCE_LIMITATIONS = Object.freeze([
  'Instrumentation disablement is SDK and instrumentation-library specific; the draft records exact candidates but cannot provide a universal source configuration.',
  'Leaf-span classifications come from normalized aggregates; verify error and business-span coverage against complete traces before applying a filter.',
  'Measured aggregate bytes prioritize recommendations, but compression and exporter overhead can change realized reduction.',
  'Head sampling can reduce APM visibility and cannot guarantee error retention without a separately validated retention policy.',
]);

export function createTraceIntelligenceArtifacts(recommendations) {
  if (recommendations.length === 0) return [];

  const resourceTrims = recommendations.filter(({ category }) => category === 'resource-attribute-trim');
  const leafFilters = recommendations.filter(({ category }) => category === 'selective-low-value-leaf-filter');
  const redundantScopes = recommendations.filter(({ category }) => category === 'redundant-instrumentation-disablement');
  const sampling = recommendations.find(({ category }) => category === 'residual-head-sampling');

  const yaml = [
    '# EXPORT-ONLY DRAFT — REVIEW BEFORE APPLYING',
    '# Generated output is never applied by telemetry-diet.',
    'processors:',
  ];

  if (resourceTrims.length > 0) {
    yaml.push(
      '  transform/trace_intelligence:',
      '    error_mode: ignore',
      '    trace_statements:',
      '      - context: span',
      '        statements:',
      ...resourceTrims.map(({ target }) => (
        `          - delete_key(resource.attributes, ${literal(target.resourceAttribute)})`
      )),
    );
  }

  if (leafFilters.length > 0) {
    yaml.push(
      '  filter/trace_intelligence:',
      '    error_mode: ignore',
      '    traces:',
      '      span:',
      ...leafFilters.map(({ target }) => yamlExpression(
        `kind == SPAN_KIND_INTERNAL and name == ${literal(target.spanName)} and instrumentation_scope.name == ${literal(target.instrumentationScope)} and status.code != STATUS_CODE_ERROR`,
      )).map((expression) => `        - ${expression}`),
    );
  }

  for (const { target } of redundantScopes) {
    yaml.push(
      `  # Source-level disablement candidate: ${target.instrumentationScope}`,
      `  # Match only ${target.spanKind} ${literal(target.spanName)}; retain ${target.retainInstrumentationScope}.`,
    );
  }

  if (sampling) {
    yaml.push(
      '  probabilistic_sampler/trace_intelligence_residual:',
      `    sampling_percentage: ${sampling.target.ratio * 100}`,
      '    # Probabilistic only: validate APM and error visibility before rollout.',
    );
  }

  const ottl = [
    '# EXPORT-ONLY DRAFT — REVIEW BEFORE APPLYING',
    '# Resource attribute statements',
    ...resourceTrims.map(({ target }) => (
      `delete_key(resource.attributes, ${literal(target.resourceAttribute)})`
    )),
    '# Exact low-value leaf-span conditions',
    ...leafFilters.map(({ target }) => (
      `drop() where kind == SPAN_KIND_INTERNAL and name == ${literal(target.spanName)} and instrumentation_scope.name == ${literal(target.instrumentationScope)} and status.code != STATUS_CODE_ERROR`
    )),
  ];

  return [
    {
      id: 'otel-collector-trace-intelligence-draft',
      label: 'OTel Collector EXPORT-ONLY DRAFT',
      format: 'otel-collector-yaml',
      apply: false,
      content: `${yaml.join('\n')}\n`,
    },
    {
      id: 'ottl-trace-intelligence-draft',
      label: 'OTTL EXPORT-ONLY DRAFT',
      format: 'ottl',
      apply: false,
      content: `${ottl.join('\n')}\n`,
    },
  ];
}

export function renderTraceIntelligenceMarkdown(result) {
  const lines = [
    '# Trace intelligence report',
    '',
    '> Recommendations are evidence-ranked drafts. Measure exported bytes, review safeguards, and validate on a limited pilot before rollout.',
    '',
    '## Summary',
    '',
    `- Aggregates analyzed: ${result.summary.aggregateCount}`,
    `- Measured bytes observed: ${result.summary.measuredBytes}`,
    `- Complete byte total: ${result.summary.byteMeasurementComplete ? result.summary.totalBytes : 'unavailable'}`,
    `- Byte measurements: ${result.summary.measuredAggregateCount} measured; ${result.summary.unmeasuredAggregateCount} unmeasured`,
    `- Spans represented: ${result.summary.totalSpans}`,
    `- Errors represented: ${result.summary.totalErrors}`,
    '',
    '## Recommendations',
    '',
  ];

  if (!result.recommendations.length) lines.push('- No guarded reduction candidate was identified.');
  for (const recommendation of result.recommendations) {
    const bytes = recommendation.estimatedByteReduction == null
      ? 'not estimated'
      : recommendation.estimatedByteReduction;
    lines.push(`- **${recommendation.category}** — ${recommendation.id}; byte reduction: ${bytes}; review required: ${recommendation.requiresReview ? 'yes' : 'no'}.`);
  }

  lines.push('', '## Limitations', '');
  lines.push(...result.limitations.map((limitation) => `- ${limitation}`));
  return lines.join('\n');
}
