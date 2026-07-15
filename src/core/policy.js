function quote(value) {
  return JSON.stringify(String(value));
}

function buildFilterExpressions(findings) {
  const expressions = [];
  for (const finding of findings) {
    if (finding.rule.kind === 'health-check') {
      const paths = finding.rule.paths.map((path) => `attributes[\"url.path\"] == ${quote(path)}`).join(' or ');
      expressions.push(`attributes[\"http.response.status_code\"] >= 200 and attributes[\"http.response.status_code\"] < 300 and (${paths})`);
    }
    if (finding.rule.kind === 'severity') {
      expressions.push(`severity_number < SEVERITY_NUMBER_INFO and resource.attributes[\"deployment.environment.name\"] == ${quote(finding.rule.environment)}`);
    }
  }
  return expressions;
}

function buildTransformStatements(findings) {
  const statements = [];
  for (const finding of findings) {
    if (finding.rule.kind === 'redact-attribute') {
      statements.push(`delete_key(attributes, ${quote(finding.rule.field)})`);
    }
    if (finding.rule.kind === 'normalize-resource') {
      if (finding.rule.serviceFields.includes('service')) {
        statements.push('set(resource.attributes["service.name"], attributes["service"]) where resource.attributes["service.name"] == nil and attributes["service"] != nil');
      }
      if (finding.rule.serviceFields.includes('app')) {
        statements.push('set(resource.attributes["service.name"], attributes["app"]) where resource.attributes["service.name"] == nil and attributes["app"] != nil');
      }
      if (finding.rule.environmentFields.includes('environment')) {
        statements.push('set(resource.attributes["deployment.environment.name"], attributes["environment"]) where resource.attributes["deployment.environment.name"] == nil and attributes["environment"] != nil');
      }
      if (finding.rule.environmentFields.includes('env')) {
        statements.push('set(resource.attributes["deployment.environment.name"], attributes["env"]) where resource.attributes["deployment.environment.name"] == nil and attributes["env"] != nil');
      }
    }
  }
  return statements;
}

export function generateOtelConfig(findings) {
  const filters = buildFilterExpressions(findings);
  const transforms = buildTransformStatements(findings);
  const lines = [
    '# Telemetry Diet draft - review and test before deployment',
    '# Best-effort OTTL for OpenTelemetry Collector contrib distributions.',
    'processors:',
  ];
  if (filters.length) {
    lines.push('  filter/telemetry_diet:', '    error_mode: ignore', '    logs:', '      log_record:');
    filters.forEach((expression) => lines.push(`        - '${expression.replaceAll("'", "''")}'`));
  }
  if (transforms.length) {
    lines.push('  transform/telemetry_diet:', '    error_mode: ignore', '    log_statements:', '      - context: log', '        statements:');
    transforms.forEach((statement) => lines.push(`          - '${statement.replaceAll("'", "''")}'`));
  }
  lines.push(
    'service:',
    '  pipelines:',
    '    logs:',
    '      # Add these after memory protection and before batching/export.',
    `      processors: [${[filters.length && 'filter/telemetry_diet', transforms.length && 'transform/telemetry_diet'].filter(Boolean).join(', ')}]`,
    '',
    '# Limitations:',
    '# - Attribute names differ across semantic-convention versions; verify against your collector.',
    '# - Fingerprint sampling and label-only removal require backend- or pipeline-specific handling.',
  );
  return lines.join('\n');
}

export function generateLast9Policy(summary, findings) {
  const rules = findings.flatMap((finding) => {
    const source = { findingId: finding.id, category: finding.category, confidence: finding.confidence };
    if (finding.rule.kind === 'health-check') return [{
      name: 'Drop successful health-check logs',
      ruleType: 'drop_log',
      filters: { all: [{ field: 'url.path', operator: 'in', values: finding.rule.paths }, { field: 'http.response.status_code', operator: 'lt', value: 300 }] },
      action: { type: 'drop' }, explanation: finding.suggestedAction, confidence: finding.confidence, sourceFinding: source,
    }];
    if (finding.rule.kind === 'severity') return [{
      name: 'Drop production debug logs', ruleType: 'drop_log',
      filters: { all: [{ field: 'severity', operator: 'in', values: finding.rule.severities }, { field: 'environment', operator: 'equals', value: finding.rule.environment }] },
      action: { type: 'drop' }, explanation: finding.suggestedAction, confidence: finding.confidence, sourceFinding: source,
    }];
    if (finding.rule.kind === 'redact-attribute') return [{
      name: `Redact ${finding.rule.field}`, ruleType: 'redact_attribute',
      filters: { field: finding.rule.field, operator: 'exists' }, action: { type: 'delete_attribute', field: finding.rule.field },
      explanation: finding.suggestedAction, confidence: finding.confidence, sourceFinding: source,
    }];
    return [];
  });
  return {
    schemaVersion: 'telemetry-diet.last9-draft/v1',
    draft: true,
    apply: false,
    provider: summary.provider,
    scope: { service: summary.service, environment: summary.environment, timeWindow: summary.timeWindow },
    rules,
    warnings: [
      'DRAFT ONLY: Telemetry Diet does not apply this policy.',
      'Validate Last9 primitive and attribute support against your current integration.',
      'Counts describe the selected window; they are not an exact cost estimate.',
    ],
  };
}

export function calculatePreview(summary, selectedFindings) {
  const dropFindings = selectedFindings.filter((finding) => finding.action === 'drop');
  const records = summary.recordsAnalyzed || 0;
  const affected = Math.min(records, dropFindings.reduce((sum, finding) => sum + finding.affectedCount, 0));
  const overlapWarning = dropFindings.length > 1
    ? 'Categories may overlap. Preview is an upper bound unless the provider returned disjoint aggregates.'
    : 'Preview is based on aggregates from the selected window.';
  return {
    recordsAnalyzed: records,
    recordsAffected: affected,
    recordsAfter: Math.max(0, records - affected),
    directionalReductionPercent: records ? Math.round((affected / records) * 1000) / 10 : 0,
    redactedFields: [...new Set(selectedFindings.filter((finding) => finding.action === 'redact').map((finding) => finding.rule.field))],
    normalizedResources: selectedFindings.some((finding) => finding.action === 'normalize'),
    caveat: overlapWarning,
  };
}
