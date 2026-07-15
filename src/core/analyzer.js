import { detectSensitiveKind, redact, redactSummary } from './redact.js';

const HEALTH_PATH = /^\/(?:health|healthz|ready|readiness|live|liveness|metrics)(?:\/|$)/i;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function finding({ id, category, title, confidence, affectedCount = 0, examples = [], suggestedAction, warning, defaultEnabled = false, action = 'review', rule = {} }) {
  return {
    id,
    category,
    title,
    confidence,
    affectedCount,
    examplesRedacted: examples.slice(0, 3).map(redact),
    suggestedAction,
    warning,
    defaultEnabled,
    action,
    rule,
  };
}

export function analyzeTelemetry(input) {
  const summary = redactSummary(input);
  const findings = [];
  const total = summary.recordsAnalyzed || 0;

  const health = (summary.endpoints || []).filter((endpoint) =>
    HEALTH_PATH.test(endpoint.path) && (!endpoint.statusClass || /^2/.test(endpoint.statusClass)),
  );
  if (health.length) {
    findings.push(finding({
      id: 'noise.health-success',
      category: 'noise',
      title: 'Successful health-check traffic',
      confidence: 'high',
      affectedCount: health.reduce((sum, endpoint) => sum + endpoint.count, 0),
      examples: health.map((endpoint) => `${endpoint.method || 'GET'} ${endpoint.path} ${endpoint.statusClass || '2xx'}`),
      suggestedAction: 'Drop successful probe logs while retaining failures and unexpected status codes.',
      warning: 'Confirm these paths are dedicated probes before applying the generated filter.',
      defaultEnabled: true,
      action: 'drop',
      rule: { kind: 'health-check', paths: health.map((endpoint) => endpoint.path), statusClass: '2xx' },
    }));
  }

  const debugMessages = (summary.messages || []).filter((message) => /debug|trace|verbose/i.test(message.severity || ''));
  if (debugMessages.length) {
    findings.push(finding({
      id: 'noise.debug',
      category: 'noise',
      title: 'Verbose DEBUG logs',
      confidence: 'high',
      affectedCount: debugMessages.reduce((sum, message) => sum + message.count, 0),
      examples: debugMessages.flatMap((message) => message.examplesRedacted || [message.fingerprint]),
      suggestedAction: 'Drop DEBUG records in production or keep a deterministic sample.',
      warning: 'DEBUG logs can be useful during incidents; the draft defaults to production only.',
      defaultEnabled: true,
      action: 'drop',
      rule: { kind: 'severity', severities: ['DEBUG', 'TRACE'], environment: summary.environment || 'production' },
    }));
  }

  const repeated = (summary.messages || [])
    .filter((message) => message.count >= Math.max(20, total * 0.05))
    .sort((a, b) => b.count - a.count)[0];
  if (repeated) {
    findings.push(finding({
      id: 'noise.repeated-fingerprint',
      category: 'noise',
      title: 'Repeated message fingerprint',
      confidence: 'medium',
      affectedCount: repeated.count,
      examples: repeated.examplesRedacted || [repeated.fingerprint],
      suggestedAction: 'Review for aggregation, rate limiting, or deterministic sampling.',
      warning: 'Fingerprint counts can overlap with health-check or DEBUG findings.',
      action: 'sample',
      rule: { kind: 'fingerprint', fingerprint: repeated.fingerprint, samplePercent: 10 },
    }));
  }

  for (const field of summary.fields || []) {
    const sensitiveKind = detectSensitiveKind(field.name, [
      ...(field.examplesRedacted || []),
      ...(field.topValues || []).map(({ value }) => value),
    ]);
    if (sensitiveKind) {
      findings.push(finding({
        id: `risk.${sensitiveKind}.${field.name}`,
        category: 'risk',
        title: sensitiveKind === 'likely-email' ? `Likely email in ${field.name}` : `Likely credential or token in ${field.name}`,
        confidence: /email|authorization|token|secret|password/i.test(field.name) ? 'high' : 'medium',
        affectedCount: field.presence || 0,
        examples: field.examplesRedacted || [],
        suggestedAction: `Delete or redact ${field.name} before export.`,
        warning: 'Name and pattern matching is conservative; manual review is recommended.',
        defaultEnabled: true,
        action: 'redact',
        rule: { kind: 'redact-attribute', field: field.name },
      }));
    }

    const uniqueRatio = field.uniqueRatio ?? (field.uniqueCount && field.presence ? field.uniqueCount / field.presence : 0);
    if (field.uniqueCount >= 20 && uniqueRatio >= 0.7) {
      findings.push(finding({
        id: `cardinality.${field.name}`,
        category: 'cardinality',
        title: `High-cardinality field: ${field.name}`,
        confidence: field.presence >= 100 ? 'high' : 'medium',
        affectedCount: field.presence || 0,
        examples: field.examplesRedacted || [],
        suggestedAction: `Keep ${field.name} out of indexed labels/tags; retain only where record-level lookup is required.`,
        warning: 'Uniqueness is calculated only for the selected window and may change with traffic shape.',
        action: 'remove-label',
        rule: { kind: 'delete-attribute', field: field.name, labelOnly: true },
      }));
    }
  }

  const serviceFields = (summary.fields || []).filter((field) => ['service', 'service.name', 'app'].includes(field.name) && field.presence);
  const environmentFields = (summary.fields || []).filter((field) => ['env', 'environment', 'deployment.environment', 'deployment.environment.name'].includes(field.name) && field.presence);
  const driftFields = [...serviceFields, ...environmentFields];
  if (serviceFields.length > 1 || environmentFields.length > 1) {
    findings.push(finding({
      id: 'drift.resource-naming',
      category: 'drift',
      title: 'Service or environment naming drift',
      confidence: 'high',
      affectedCount: Math.max(...driftFields.map((field) => field.presence || 0)),
      examples: driftFields.map((field) => `${field.name}=${field.topValues?.[0]?.value || '(varied)'}`),
      suggestedAction: 'Normalize to service.name and deployment.environment.name at collection time.',
      warning: 'Verify precedence when two source fields disagree.',
      defaultEnabled: true,
      action: 'normalize',
      rule: { kind: 'normalize-resource', serviceFields: serviceFields.map(({ name }) => name), environmentFields: environmentFields.map(({ name }) => name) },
    }));
  }

  const unsafe = (summary.fields || []).filter((field) => {
    const ratio = field.uniqueRatio ?? (field.uniqueCount && field.presence ? field.uniqueCount / field.presence : 0);
    return ratio >= 0.7 || detectSensitiveKind(field.name, field.examplesRedacted || []);
  });
  if (unsafe.length) {
    findings.push(finding({
      id: 'cardinality.unsafe-labels',
      category: 'cardinality',
      title: 'Fields unsafe for labels or tags',
      confidence: 'high',
      affectedCount: Math.max(...unsafe.map((field) => field.presence || 0)),
      examples: unsafe.map((field) => field.name),
      suggestedAction: 'Exclude these fields from metric labels, indexed facets, and routing tags.',
      warning: 'This recommendation does not require deleting fields from log bodies.',
      action: 'review',
      rule: { kind: 'unsafe-labels', fields: unsafe.map(({ name }) => name) },
    }));
  }

  return findings.sort((a, b) => {
    const categoryOrder = { risk: 0, noise: 1, cardinality: 2, drift: 3 };
    return (categoryOrder[a.category] - categoryOrder[b.category]) ||
      (CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]) ||
      (b.affectedCount - a.affectedCount) || a.id.localeCompare(b.id);
  });
}
