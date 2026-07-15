export const DEFAULT_PROTECTED_PREFIXES = Object.freeze([
  'trace_',
  'node_',
  'system_',
  'process_',
  'kube_',
  'container_',
  'namedprocess_',
]);

export function createProtectionPolicy({
  enabled = true,
  prefixes = DEFAULT_PROTECTED_PREFIXES,
  metricNames = [],
} = {}) {
  const exactNames = new Set(metricNames);
  const normalizedPrefixes = [...prefixes];

  return {
    enabled,
    protects(metricName) {
      if (!enabled) return false;
      return exactNames.has(metricName) || normalizedPrefixes.some((prefix) => metricName.startsWith(prefix));
    },
  };
}
