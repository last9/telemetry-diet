const EMAIL_PATTERN = /\b([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_KEY_PATTERN = /\b((?:sk|pk|api|key|token)[_-]?(?:live|test)?[_-]?)[A-Za-z0-9_-]{8,}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SESSION_PATTERN = /\b((?:session|sid|request|trace)[_.:-]?(?:id)?[=: ]+)[A-Za-z0-9_-]{8,}\b/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /(\b(?:password|passwd|pwd|secret|api[_.-]?key|access[_.-]?token|auth[_.-]?token|authorization|cookie|session[_.-]?id)(?:["']?)[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const EMAIL_DETECT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BEARER_DETECT_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i;
const JWT_DETECT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

export function redact(value) {
  if (value == null) return value;
  return String(value)
    .replace(EMAIL_PATTERN, '$1***@$2')
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(API_KEY_PATTERN, '$1[REDACTED]')
    .replace(SESSION_PATTERN, '$1[REDACTED]');
}

export function redactFieldValue(name, value) {
  if (value == null) return value;
  const kind = detectSensitiveKind(name, [String(value)]);
  if (kind === 'likely-secret' || kind === 'likely-token') return '[REDACTED]';
  if (kind === 'likely-email') {
    const masked = redact(value);
    return masked === String(value) ? '[REDACTED_EMAIL]' : masked;
  }
  return redact(value);
}

export function detectSensitiveKind(name, examples = []) {
  const key = name.toLowerCase();
  const joined = examples.join(' ');
  if (/email|e-mail/.test(key) || EMAIL_DETECT_PATTERN.test(joined)) return 'likely-email';
  if (/authorization|api.?key|secret|password|passwd|access.?token|auth.?token/.test(key)) return 'likely-secret';
  if (/session.?id|cookie/.test(key) || BEARER_DETECT_PATTERN.test(joined) || JWT_DETECT_PATTERN.test(joined)) return 'likely-token';
  return null;
}

export function redactSummary(summary) {
  return {
    provider: summary.provider,
    service: summary.service,
    environment: summary.environment,
    timeWindow: summary.timeWindow,
    recordsAnalyzed: summary.recordsAnalyzed,
    fields: (summary.fields || []).map((field) => ({
      name: field.name,
      type: field.type,
      presence: field.presence,
      uniqueCount: field.uniqueCount,
      uniqueRatio: field.uniqueRatio,
      risks: Array.isArray(field.risks) ? field.risks.map(redact) : undefined,
      examplesRedacted: (field.examplesRedacted || []).map((value) => redactFieldValue(field.name, value)),
      topValues: (field.topValues || []).map((entry) => ({ value: redactFieldValue(field.name, entry.value), count: entry.count })),
    })),
    messages: (summary.messages || []).map((message) => ({
      count: message.count,
      severity: message.severity,
      fingerprint: redact(message.fingerprint),
      examplesRedacted: (message.examplesRedacted || []).map(redact),
    })),
    endpoints: (summary.endpoints || []).map((endpoint) => ({
      path: redact(endpoint.path),
      method: endpoint.method,
      statusClass: endpoint.statusClass,
      count: endpoint.count,
    })),
    existingPolicies: (summary.existingPolicies || []).map((policy) => ({
      provider: policy.provider,
      name: redact(policy.name),
      type: redact(policy.type),
      summary: redact(policy.summary),
    })),
    limitations: (summary.limitations || []).map((limitation) => (
      redact(typeof limitation === 'string' ? limitation : limitation?.message || JSON.stringify(limitation))
    )).filter((limitation) => typeof limitation === 'string' && limitation),
  };
}
