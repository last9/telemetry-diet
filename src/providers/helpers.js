import { redact } from '../core/redact.js';

export function findTool(tools, names) {
  const lowered = names.map((name) => name.toLowerCase());
  return tools.find((tool) => lowered.includes(tool.name.toLowerCase())) ||
    tools.find((tool) => lowered.some((name) => tool.name.toLowerCase().endsWith(name)));
}

export function toolArgs(tool, values) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const args = {};
  for (const key of Object.keys(properties)) {
    if (values[key] != null) args[key] = values[key];
    else if (/^service(?:_name)?$/i.test(key) && values.service != null) args[key] = values.service;
    else if (/^(?:env|environment)$/i.test(key) && values.environment != null) args[key] = values.environment;
    else if (/^(?:start|from|start_time_iso)$/i.test(key) && values.start != null) args[key] = values.start;
    else if (/^(?:end|to|end_time_iso)$/i.test(key) && values.end != null) args[key] = values.end;
    else if (/^(?:limit|count|size)$/i.test(key) && values.limit != null) args[key] = values.limit;
  }
  for (const key of required) {
    if (args[key] != null) continue;
    if (/query|filter|search/i.test(key)) args[key] = values.query || '*';
    else if (/from|start|since/i.test(key)) args[key] = values.start;
    else if (/to|end|until/i.test(key)) args[key] = values.end;
    else if (/service/i.test(key)) args[key] = values.service;
    else if (/env/i.test(key)) args[key] = values.environment;
    else if (/limit|count|size/i.test(key)) args[key] = values.limit || 200;
    else if (/time.?window|time.?range|period/i.test(key)) args[key] = { start: values.start, end: values.end };
    else if (key === 'telemetry') args[key] = { intent: values.intent || 'Perform a read-only telemetry policy analysis.' };
  }
  return args;
}

export function unwrapPayload(payload) {
  if (payload?.data != null) return payload.data;
  if (payload?.result != null) return payload.result;
  return payload;
}

function namedItems(value, keys, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      const name = item?.name || item?.service || item?.service_name || item?.['service.name'];
      return name ? [String(name)] : [];
    });
  }
  if (typeof value !== 'object') return [];
  for (const key of keys) {
    if (value[key] != null) {
      const found = namedItems(value[key], keys, depth + 1);
      if (found.length) return found;
    }
  }
  const directName = value.name || value.service || value.service_name || value.ServiceName || value['service.name'];
  if (directName) return [String(directName)];
  return Object.values(value).flatMap((entry) => namedItems(entry, keys, depth + 1));
}

export function extractServices(payload) {
  return [...new Set(namedItems(unwrapPayload(payload), ['services', 'service_names', 'items']))].sort();
}

export function extractEnvironments(payload) {
  const data = unwrapPayload(payload);
  const direct = data?.environments || data?.envs || data?.items || data;
  if (!Array.isArray(direct)) return [];
  return [...new Set(direct.map((item) => typeof item === 'string' ? item : item?.name || item?.environment || item?.env).filter(Boolean).map(String))].sort();
}

function flatten(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) flatten(entry, name, output);
    else if (entry != null) output[name] = Array.isArray(entry) ? JSON.stringify(entry) : String(entry);
  }
  return output;
}

function recordsFrom(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === 'object')) return value.filter((item) => item && typeof item === 'object');
    return [];
  }
  if (typeof value !== 'object') return [];
  for (const key of ['logs', 'events', 'records', 'items', 'results', 'hits']) {
    const found = recordsFrom(value[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function fingerprint(message) {
  return redact(String(message || '(empty message)'))
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '?')
    .replace(/\b(?:[a-z]+_)?[a-z0-9_-]{16,}\b/gi, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .slice(0, 180);
}

function pathOf(attributes, record) {
  return attributes['url.path'] || attributes['http.route'] || attributes['http.url_details.path'] ||
    attributes['attributes.url.path'] || record.path || record.url_path;
}

function statusOf(attributes, record) {
  const raw = attributes['http.response.status_code'] || attributes['http.status_code'] ||
    attributes['attributes.http.status_code'] || record.status_code || record.status;
  const status = Number(raw);
  return Number.isFinite(status) ? `${Math.floor(status / 100)}xx` : undefined;
}

export function summarizeRecords(records, context, metadata = {}) {
  const fieldValues = new Map();
  const messageGroups = new Map();
  const endpointGroups = new Map();
  for (const record of records.slice(0, 1000)) {
    const direct = flatten(record);
    for (const key of ['message', 'content', 'body', 'text', 'msg', 'timestamp', 'status', 'severity', 'level', 'host', 'service']) delete direct[key];
    const attributes = {
      ...direct,
      ...flatten(record.attributes || record.attribute || record.facets || {}),
      ...flatten(record.resource || {}),
    };
    for (const [key, value] of Object.entries(attributes)) {
      if (!fieldValues.has(key)) fieldValues.set(key, []);
      fieldValues.get(key).push(value);
    }
    const message = record.message || record.content || record.body || record.text || record.msg;
    if (message) {
      const key = fingerprint(message);
      const current = messageGroups.get(key) || { fingerprint: key, count: 0, severity: record.severity || record.status || record.level, examplesRedacted: [] };
      current.count++;
      if (current.examplesRedacted.length < 2) current.examplesRedacted.push(redact(message));
      messageGroups.set(key, current);
    }
    const path = pathOf(attributes, record);
    if (path) {
      const method = attributes['http.request.method'] || attributes['http.method'] || record.method;
      const statusClass = statusOf(attributes, record);
      const key = `${method || ''}|${path}|${statusClass || ''}`;
      const current = endpointGroups.get(key) || { path, method, statusClass, count: 0 };
      current.count++;
      endpointGroups.set(key, current);
    }
  }
  const fields = [...fieldValues].map(([name, values]) => {
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    const topValues = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: redact(value), count }));
    return {
      name,
      type: 'string',
      presence: values.length,
      uniqueCount: counts.size,
      uniqueRatio: values.length ? Math.round((counts.size / values.length) * 1000) / 1000 : 0,
      topValues,
      examplesRedacted: topValues.slice(0, 2).map(({ value }) => value),
    };
  });
  return {
    provider: context.provider,
    service: context.service,
    environment: context.environment,
    timeWindow: context.timeWindow,
    recordsAnalyzed: metadata.total ?? records.length,
    fields,
    messages: [...messageGroups.values()].sort((a, b) => b.count - a.count),
    endpoints: [...endpointGroups.values()].sort((a, b) => b.count - a.count),
    existingPolicies: metadata.existingPolicies || [],
    limitations: metadata.limitations || [],
  };
}

export function normalizedFromPayload(payload, context, metadata = {}) {
  const data = unwrapPayload(payload);
  const summary = data?.summary || data?.telemetrySummary || data;
  if (summary && Array.isArray(summary.fields) && (Array.isArray(summary.messages) || Array.isArray(summary.endpoints))) {
    return {
      ...summary,
      fields: summary.fields || [],
      messages: summary.messages || [],
      endpoints: summary.endpoints || [],
      provider: context.provider,
      service: context.service || summary.service,
      environment: context.environment || summary.environment,
      timeWindow: context.timeWindow,
      existingPolicies: metadata.existingPolicies || summary.existingPolicies || [],
    };
  }
  const records = recordsFrom(data);
  if (records.length) {
    const limited = metadata.recordLimit ? records.slice(0, metadata.recordLimit) : records;
    return summarizeRecords(limited, context, { ...metadata, total: data?.total ?? data?.count ?? metadata.total });
  }
  return null;
}

export function providerQuery(service, environment) {
  return [service && service !== '*' && `service:${service}`, environment && environment !== '*' && `env:${environment}`].filter(Boolean).join(' ') || '*';
}
