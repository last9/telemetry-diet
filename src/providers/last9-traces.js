import { createMcpClient } from '../mcp/client.js';
import { providerQuery } from './helpers.js';
import { resolveLast9McpConfig } from './last9.js';
import { isSafeLast9ReadTool } from './last9-tool-safety.js';

const MAX_TRACE_RECORDS = 200;
const MAX_RESOURCE_ATTRIBUTES = 100;
const MAX_EVIDENCE_STRING_LENGTH = 512;
const AGGREGATE_ALIASES = ['analyze_trace_aggregates', 'get_trace_aggregates', 'get_span_statistics'];
const FALLBACK_ALIASES = ['get_service_traces', 'search_traces'];

function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function aggregateScore(tool) {
  const name = String(tool?.name || '').toLowerCase();
  const exact = AGGREGATE_ALIASES.indexOf(name);
  if (!isSafeLast9ReadTool(tool, AGGREGATE_ALIASES)) return -1;
  const haystack = words(`${tool.name} ${tool.title || ''} ${tool.description || ''}`);
  if (!/\b(traces?|spans?)\b/.test(haystack)) return -1;
  if (!/\b(aggregates?|analysis|analyze|breakdown|statistics|stats|summary|summarize)\b/.test(haystack)) return -1;
  if (name === 'analyze_trace_aggregates') return 1_000;
  if (exact >= 0) return 900 - exact;
  if (/aggregate/.test(name)) return 500;
  return 100;
}

function resolveAggregateTool(tools) {
  return tools
    .map((tool) => ({ tool, score: aggregateScore(tool) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.tool;
}

function fallbackScore(tool) {
  const name = String(tool?.name || '').toLowerCase();
  const exact = FALLBACK_ALIASES.indexOf(name);
  const compatible = exact >= 0
    ? exact
    : FALLBACK_ALIASES.findIndex((alias) => name.endsWith(`_${alias}`));
  if (compatible < 0 || !isSafeLast9ReadTool(tool, FALLBACK_ALIASES)) return -1;
  const keys = new Set([
    ...Object.keys(tool.inputSchema?.properties || {}),
    ...(tool.inputSchema?.required || []),
  ]);
  if (![...keys].some((key) => /^(?:limit|count|page_?size|size)$/i.test(key))) return -1;
  return 100 - compatible;
}

function resolveFallbackTool(tools) {
  return tools
    .map((tool) => ({ tool, score: fallbackScore(tool) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.tool;
}

function toolArguments(tool, scope = {}) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const args = {};
  const values = {
    service: scope.service,
    environment: scope.environment === '*' ? undefined : scope.environment,
    start: scope.timeWindow?.start,
    end: scope.timeWindow?.end,
  };
  for (const key of new Set([...Object.keys(properties), ...required])) {
    if (/^service(?:_?name)?$/i.test(key) && values.service != null) args[key] = values.service;
    else if (/^(?:env|environment)$/i.test(key) && values.environment != null) args[key] = values.environment;
    else if (/^(?:start|from|start_?time(?:_?iso)?)$/i.test(key) && values.start != null) args[key] = values.start;
    else if (/^(?:end|to|end_?time(?:_?iso)?)$/i.test(key) && values.end != null) args[key] = values.end;
    else if (/^(?:limit|count|page_?size|size)$/i.test(key)) args[key] = MAX_TRACE_RECORDS;
    else if (/^(?:query|filter|search)$/i.test(key)) args[key] = providerQuery(values.service, values.environment);
  }
  return args;
}

function own(value, keys) {
  for (const key of keys) {
    if (Object.hasOwn(value || {}, key) && value[key] != null) return value[key];
  }
  return undefined;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function boolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function safeEvidenceString(value) {
  if (typeof value !== 'string') return undefined;
  if (value.length > MAX_EVIDENCE_STRING_LENGTH) {
    throw new Error('Last9 trace aggregate response exceeded safe analysis bounds.');
  }
  return value;
}

function normalizedSpanKind(value) {
  const kind = safeEvidenceString(String(value || 'UNSPECIFIED'))
    ?.toUpperCase()
    .replace(/^SPAN_KIND_/, '');
  return ['CLIENT', 'CONSUMER', 'INTERNAL', 'PRODUCER', 'SERVER', 'UNSPECIFIED'].includes(kind)
    ? kind
    : 'UNSPECIFIED';
}

function resourceAttributes(value) {
  const entries = Array.isArray(value)
    ? value
    : Object.keys(value || {}).map((key) => ({ key }));
  if (entries.length > MAX_RESOURCE_ATTRIBUTES) {
    throw new Error('Last9 trace aggregate response exceeded safe analysis bounds.');
  }
  return entries.flatMap((attribute) => {
    const key = safeEvidenceString(own(attribute, ['key', 'name']));
    if (!key) return [];
    return [compact({
      key,
      bytes: finiteNumber(own(attribute, ['bytes', 'total_bytes', 'size_bytes'])),
      safeToTrim: boolean(own(attribute, ['safeToTrim', 'safe_to_trim'])),
    })];
  });
}

function spanCollection(value, output = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || output.length >= MAX_TRACE_RECORDS) return output;
  const spanMarkers = [
    'spanId', 'span_id', 'parentSpanId', 'parent_span_id',
    'spanKind', 'span_kind', 'instrumentationScope', 'instrumentation_scope',
  ];
  if (!Array.isArray(value) && spanMarkers.some((key) => Object.hasOwn(value, key)) && rawSpanIdentity(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value.spans)) {
    for (const span of value.spans) {
      if (output.length >= MAX_TRACE_RECORDS) break;
      if (span && typeof span === 'object') output.push(span);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'spans' && item && typeof item === 'object') spanCollection(item, output, depth + 1);
    if (output.length >= MAX_TRACE_RECORDS) break;
  }
  return output;
}

function rawSpanIdentity(span) {
  const kind = normalizedSpanKind(own(span, ['spanKind', 'span_kind', 'kind']));
  const name = safeEvidenceString(own(span, ['spanName', 'span_name', 'operationName', 'operation_name', 'name']));
  const rawScope = own(span, ['instrumentationScope', 'instrumentation_scope', 'scopeName', 'scope_name', 'libraryName', 'library_name']);
  const scope = safeEvidenceString(typeof rawScope === 'object' ? own(rawScope, ['name']) : rawScope);
  if (!name) return null;
  return { kind, name, scope: scope || 'unknown' };
}

function rawSpanAttributes(span) {
  return resourceAttributes(
    own(span, ['resourceAttributes', 'resource_attributes'])
    ?? span.resource?.attributes
    ?? span.resource,
  );
}

function rawSpanIsError(span) {
  if (span.error === true) return true;
  const code = typeof span.status === 'object' ? span.status?.code : own(span, ['statusCode', 'status_code']);
  const normalized = String(code || '').toUpperCase();
  return Number(code) === 2 || normalized === 'ERROR' || normalized === 'STATUS_CODE_ERROR';
}

function aggregateRawSpans(payload) {
  const spans = spanCollection(payload).slice(0, MAX_TRACE_RECORDS);
  if (!spans.length) return null;
  const groups = new Map();
  for (const span of spans) {
    const identity = rawSpanIdentity(span);
    if (!identity) continue;
    const key = `${identity.kind}\u0000${identity.name}\u0000${identity.scope}`;
    const current = groups.get(key) || {
      spanKind: identity.kind,
      spanName: identity.name,
      instrumentationScope: identity.scope,
      resourceAttributes: new Map(),
      count: 0,
      errorCount: 0,
      bytes: 0,
      bytesKnown: true,
      leaf: true,
      lowValue: true,
      businessSpan: false,
    };
    current.count += 1;
    if (rawSpanIsError(span)) current.errorCount += 1;
    const bytes = finiteNumber(own(span, ['bytes', 'total_bytes', 'size_bytes']));
    if (bytes === undefined) current.bytesKnown = false;
    else current.bytes += bytes;
    current.leaf = current.leaf && boolean(own(span, ['leaf', 'is_leaf'])) === true;
    current.lowValue = current.lowValue && boolean(own(span, ['lowValue', 'low_value'])) === true;
    current.businessSpan = current.businessSpan || boolean(own(span, ['businessSpan', 'business_span'])) === true;
    for (const attribute of rawSpanAttributes(span)) {
      if (!current.resourceAttributes.has(attribute.key)) current.resourceAttributes.set(attribute.key, { key: attribute.key });
    }
    groups.set(key, current);
  }
  if (!groups.size) return null;
  return {
    aggregates: [...groups.values()].map((group) => compact({
      spanKind: group.spanKind,
      spanName: group.spanName,
      instrumentationScope: group.instrumentationScope,
      resourceAttributes: [...group.resourceAttributes.values()].sort((left, right) => left.key.localeCompare(right.key)),
      bytes: group.bytesKnown ? group.bytes : undefined,
      count: group.count,
      errorCount: group.errorCount,
      leaf: group.leaf,
      lowValue: group.lowValue,
      businessSpan: group.businessSpan,
    })),
  };
}

function normalizeAggregate(value) {
  if (!value || typeof value !== 'object') return null;
  const spanKind = own(value, ['spanKind', 'span_kind', 'kind']);
  const spanName = safeEvidenceString(own(value, ['spanName', 'span_name', 'operationName', 'operation_name', 'name']));
  const scope = own(value, ['instrumentationScope', 'instrumentation_scope', 'scopeName', 'scope_name', 'libraryName', 'library_name']);
  const instrumentationScope = safeEvidenceString(typeof scope === 'object' ? own(scope, ['name']) : scope);
  const count = finiteNumber(own(value, ['count', 'span_count', 'total_spans']));
  if (!spanName || count === undefined) return null;
  const redundantWith = safeEvidenceString(own(value, ['redundantWith', 'redundant_with']));
  const httpRoute = safeEvidenceString(own(value, ['httpRoute', 'http_route', 'route']));
  return compact({
    spanKind: normalizedSpanKind(spanKind),
    spanName,
    instrumentationScope: typeof instrumentationScope === 'string' ? instrumentationScope : 'unknown',
    resourceAttributes: resourceAttributes(own(value, ['resourceAttributes', 'resource_attributes'])),
    bytes: finiteNumber(own(value, ['bytes', 'total_bytes', 'size_bytes'])),
    count,
    errorCount: finiteNumber(own(value, ['errorCount', 'error_count', 'errors'])),
    httpRoute,
    averageDurationMs: finiteNumber(own(value, [
      'averageDurationMs', 'average_duration_ms', 'avgDurationMs', 'avg_duration_ms',
    ])),
    leaf: boolean(own(value, ['leaf', 'is_leaf'])),
    lowValue: boolean(own(value, ['lowValue', 'low_value'])),
    businessSpan: boolean(own(value, ['businessSpan', 'business_span'])),
    redundantWith,
  });
}

function findAggregateCollection(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  for (const key of ['aggregates', 'span_aggregates', 'trace_aggregates', 'groups']) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const item of Object.values(value)) {
    const found = findAggregateCollection(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function residualHeadSampling(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  const candidate = value.residualHeadSampling || value.residual_head_sampling;
  const ratio = finiteNumber(candidate?.ratio);
  if (ratio !== undefined) return { ratio };
  for (const item of Object.values(value)) {
    const found = residualHeadSampling(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function fastSuccessCandidates(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  const candidate = value.fastSuccessCandidates || value.fast_success_candidates;
  const maxAverageDurationMs = finiteNumber(
    candidate?.maxAverageDurationMs ?? candidate?.max_average_duration_ms,
  );
  if (maxAverageDurationMs !== undefined) return { maxAverageDurationMs };
  for (const item of Object.values(value)) {
    const found = fastSuccessCandidates(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function normalizeAggregatePayload(payload) {
  const collection = Array.isArray(payload) ? payload : findAggregateCollection(payload);
  if (collection?.length > MAX_TRACE_RECORDS) {
    throw new Error('Last9 trace aggregate response exceeded safe analysis bounds.');
  }
  const aggregates = collection?.map(normalizeAggregate).filter(Boolean) || [];
  if (!aggregates.length) return null;
  return compact({
    aggregates,
    residualHeadSampling: residualHeadSampling(payload),
    fastSuccessCandidates: fastSuccessCandidates(payload),
  });
}

export class Last9TracesAdapter {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.oauth = options.oauth;
    this.provider = 'last9';
    this.readOnly = true;
  }

  async connect() {
    const config = resolveLast9McpConfig(this.env);
    if (!config.configured) {
      throw new Error('Last9 organization is not configured. Set TELEMETRY_DIET_LAST9_ORG_SLUG once, then use provider login.');
    }
    this.client = await createMcpClient({
      label: 'Last9',
      envPrefix: 'TELEMETRY_DIET_LAST9',
      url: config.url,
      token: config.token,
      command: config.command,
      args: config.args,
      timeout: 180000,
      oauthClient: config.mode === 'hosted-oauth' ? this.oauth?.createClient('last9', config.url) : undefined,
    });
    this.tools = await this.client.listTools();
    this.aggregateTool = resolveAggregateTool(this.tools);
    this.fallbackTool = this.aggregateTool ? undefined : resolveFallbackTool(this.tools);
    if (!this.aggregateTool && !this.fallbackTool) {
      throw new Error('Last9 MCP must expose a read-only aggregate trace analysis capability or a bounded trace-search fallback.');
    }
    return {
      provider: this.provider,
      readOnly: true,
      serverInfo: this.client.serverInfo,
      tools: [this.aggregateTool || this.fallbackTool].map(({ name }) => name),
    };
  }

  async collect(scope = {}) {
    const tool = this.aggregateTool || this.fallbackTool;
    if (!this.client || !tool) throw new Error('Connect the Last9 traces adapter before collecting.');
    let payload;
    try {
      payload = await this.client.callTool(tool.name, toolArguments(tool, scope));
    } catch {
      throw new Error('Last9 aggregate trace analysis could not be collected.');
    }
    const normalized = this.aggregateTool
      ? normalizeAggregatePayload(payload)
      : aggregateRawSpans(payload);
    if (!normalized) throw new Error('Last9 trace response contained no recognizable aggregates.');
    return normalized;
  }

  close() { return this.client?.close(); }
}
