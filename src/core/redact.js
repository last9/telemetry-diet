const EMAIL_PATTERN = /\b([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const API_KEY_PATTERN = /\b((?:sk|pk|api|key|token)[_-]?(?:live|test)?[_-]?)[A-Za-z0-9_-]{8,}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SESSION_PATTERN = /\b((?:session|sid|request|trace)[_.:-]?(?:id)?[=: ]+)[A-Za-z0-9_-]{8,}\b/gi;
const EMAIL_DETECT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BEARER_DETECT_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i;
const JWT_DETECT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

export function redact(value) {
  if (value == null) return value;
  return String(value)
    .replace(EMAIL_PATTERN, '$1***@$2')
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(API_KEY_PATTERN, '$1[REDACTED]')
    .replace(SESSION_PATTERN, '$1[REDACTED]');
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
    ...summary,
    fields: (summary.fields || []).map((field) => ({
      ...field,
      examplesRedacted: (field.examplesRedacted || []).map(redact),
      topValues: (field.topValues || []).map((entry) => ({ ...entry, value: redact(entry.value) })),
    })),
    messages: (summary.messages || []).map((message) => ({
      ...message,
      examplesRedacted: (message.examplesRedacted || []).map(redact),
    })),
  };
}
