import { summarizeRecords, unwrapPayload } from './helpers.js';

export function servicesFromLast9Summary(payload) {
  const data = unwrapPayload(payload);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const services = Object.entries(data).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return [];
    const name = value.ServiceName || value.service_name;
    if (name) return [String(name)];
    const looksLikeSummary = ['Throughput', 'ErrorRate', 'ResponseTime'].some((field) => field in value);
    return looksLikeSummary ? [key] : [];
  });
  return [...new Set(services)].sort();
}

export function environmentsFromLast9(payload) {
  const data = unwrapPayload(payload);
  const values = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value).map(String))].sort();
}

export function policiesFromLast9(payload) {
  const data = unwrapPayload(payload);
  const candidates = Array.isArray(data) ? data
    : Array.isArray(data?.rules) ? data.rules
      : Array.isArray(data?.drop_rules) ? data.drop_rules
        : Array.isArray(data?.data) ? data.data : [];
  return candidates.filter((rule) => rule && typeof rule === 'object').map((rule) => ({
    provider: 'last9',
    name: rule.name || rule.id || 'Existing drop rule',
    type: rule.type || rule.telemetry || 'drop',
    summary: rule.summary || rule.description || JSON.stringify(rule.filters || {}),
  }));
}

export function normalizeLast9Logs(payload, context, { existingPolicies = [], limit = 200 } = {}) {
  const data = unwrapPayload(payload);
  if (!data || typeof data !== 'object' || !Array.isArray(data.logs)) return null;
  const limitations = [
    `Field ratios and fingerprints use at most ${limit} records returned by Last9 MCP.`,
  ];
  if (data.partial_result) limitations.push('Last9 marked this as a partial result; manual review is recommended.');
  if (data.warning) limitations.push(String(data.warning));
  return summarizeRecords(data.logs.slice(0, limit), context, {
    total: Number.isFinite(Number(data.count)) ? Number(data.count) : data.logs.length,
    existingPolicies,
    limitations,
  });
}
