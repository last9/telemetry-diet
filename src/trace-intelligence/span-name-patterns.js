const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{16,64}\b/gi;

export const SPAN_NAME_PATTERN_DRAFTS = Object.freeze({
  uuid: Object.freeze({
    pattern: String.raw`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`,
    replacement: '{uuid}',
  }),
  hex: Object.freeze({
    pattern: String.raw`(?i)\b[0-9a-f]{16,64}\b`,
    replacement: '{hex}',
  }),
});

export function normalizeHighCardinalitySpanName(value) {
  const spanName = String(value || '');
  const patterns = [];
  const withoutUuids = spanName.replace(UUID_PATTERN, () => {
    patterns.push('uuid');
    return '{uuid}';
  });
  const normalizedSpanName = withoutUuids.replace(LONG_HEX_PATTERN, () => {
    patterns.push('hex');
    return '{hex}';
  });

  return {
    normalizedSpanName,
    patterns: [...new Set(patterns)].sort(),
    changed: normalizedSpanName !== spanName,
  };
}
