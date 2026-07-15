import { createMcpClient } from '../mcp/client.js';
import { extractServices, findTool, normalizedFromPayload, providerQuery, toolArgs } from './helpers.js';
import { redact } from '../core/redact.js';

const DATADOG_MCP_URL = 'https://mcp.datadoghq.com/v1/mcp';

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function resolveDatadogMcpConfig(env = process.env) {
  const url = env.TELEMETRY_DIET_DATADOG_MCP_URL || DATADOG_MCP_URL;
  const explicitCommand = env.TELEMETRY_DIET_DATADOG_MCP_COMMAND;
  return {
    url: explicitCommand ? undefined : url,
    token: env.TELEMETRY_DIET_DATADOG_MCP_TOKEN,
    command: explicitCommand,
    args: env.TELEMETRY_DIET_DATADOG_MCP_ARGS,
    configured: true,
    mode: explicitCommand ? 'custom-command' : env.TELEMETRY_DIET_DATADOG_MCP_TOKEN ? 'http-token' : 'hosted-oauth',
  };
}

export function datadogAggregateQueries(service, environment) {
  return {
    overview: [
      'SELECT COUNT(*) AS records_analyzed,',
      'COUNT("@request.id") AS request_id_presence, COUNT(DISTINCT "@request.id") AS request_id_unique_count,',
      'COUNT("@session.id") AS session_id_presence, COUNT(DISTINCT "@session.id") AS session_id_unique_count,',
      'COUNT("@user.id") AS user_id_presence, COUNT(DISTINCT "@user.id") AS user_id_unique_count,',
      'COUNT("@user.email") AS user_email_presence, COUNT(DISTINCT "@user.email") AS user_email_unique_count,',
      'COUNT("@http.request.header.authorization") AS authorization_presence, COUNT(DISTINCT "@http.request.header.authorization") AS authorization_unique_count',
      'FROM logs',
    ].join(' '),
    fingerprints: [
      'SELECT status AS severity, "@http.url_details.path" AS path, "@http.method" AS method,',
      '"@http.status_code" AS status_code, message, COUNT(*) AS record_count FROM logs',
      'GROUP BY status, "@http.url_details.path", "@http.method", "@http.status_code", message ORDER BY record_count DESC LIMIT 200',
    ].join(' '),
  };
}

const DATADOG_EXTRA_COLUMNS = [
  { name: '@request.id', type: 'varchar' },
  { name: '@session.id', type: 'varchar' },
  { name: '@user.id', type: 'varchar' },
  { name: '@user.email', type: 'varchar' },
  { name: '@http.request.header.authorization', type: 'varchar' },
  { name: '@http.url_details.path', type: 'varchar' },
  { name: '@http.method', type: 'varchar' },
  { name: '@http.status_code', type: 'bigint' },
];

function parseTsvEnvelope(text) {
  const match = String(text || '').match(/<TSV_DATA>\s*\n?([\s\S]*?)\n?<\/TSV_DATA>/);
  if (!match) return [];
  const lines = match[1].trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => {
    const normalized = header.replace(/^(?:custom|attributes)\./, '');
    return [normalized, line.split('\t')[index] ?? ''];
  })));
}

function structuredDatadogPayload(payload) {
  const rows = parseTsvEnvelope(payload?.text);
  return rows.length ? { rows } : payload;
}

function rowsFrom(payload, depth = 0) {
  if (depth > 5 || payload == null) return [];
  if (Array.isArray(payload)) return payload.filter((entry) => entry && typeof entry === 'object');
  if (typeof payload !== 'object') return [];
  if (typeof payload.text === 'string') {
    const parsed = parseTsvEnvelope(payload.text);
    if (parsed.length) return parsed;
  }
  if ('records_analyzed' in payload || 'record_count' in payload || 'message' in payload) return [payload];
  for (const key of ['rows', 'results', 'data', 'items', 'series']) {
    const rows = rowsFrom(payload[key], depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

function value(row, ...keys) {
  for (const key of keys) if (row?.[key] != null) return row[key];
  return undefined;
}

function count(row) {
  const raw = value(row, 'record_count', 'count', 'records', 'value');
  return Number(raw) || 0;
}

function aggregateSummary(overviewPayload, fingerprintPayload, context) {
  const overview = rowsFrom(overviewPayload)[0] || {};
  const rows = rowsFrom(fingerprintPayload);
  const recordsAnalyzed = Number(value(overview, 'records_analyzed', 'total', 'count')) || rows.reduce((sum, row) => sum + count(row), 0);
  const specs = [
    ['request.id', 'request_id'], ['session.id', 'session_id'], ['user.id', 'user_id'],
    ['user.email', 'user_email'], ['http.request.header.authorization', 'authorization'],
  ];
  const fields = specs.flatMap(([name, alias]) => {
    const presence = Number(value(overview, `${alias}_presence`)) || 0;
    const uniqueCount = Number(value(overview, `${alias}_unique_count`)) || 0;
    return presence ? [{ name, type: 'string', presence, uniqueCount, uniqueRatio: presence ? uniqueCount / presence : 0, examplesRedacted: [] }] : [];
  });
  if (recordsAnalyzed) {
    fields.unshift(
      { name: 'service', type: 'string', presence: recordsAnalyzed, uniqueCount: 1, uniqueRatio: 1 / recordsAnalyzed, topValues: [{ value: context.service, count: recordsAnalyzed }] },
      ...(context.environment ? [{ name: 'env', type: 'string', presence: recordsAnalyzed, uniqueCount: 1, uniqueRatio: 1 / recordsAnalyzed, topValues: [{ value: context.environment, count: recordsAnalyzed }] }] : []),
    );
  }
  const messages = rows.filter((row) => value(row, 'message', 'fingerprint')).map((row) => {
    const message = redact(value(row, 'message', 'fingerprint'));
    return {
      fingerprint: message.toLowerCase().replace(/\b\d+(?:\.\d+)?\b/g, '?').slice(0, 180),
      count: count(row),
      severity: value(row, 'severity', 'status', 'level'),
      examplesRedacted: [message],
    };
  });
  const endpoints = rows.filter((row) => value(row, 'path', 'url_path', 'http_path')).map((row) => {
    const status = Number(value(row, 'status_code', 'http_status_code'));
    return {
      path: value(row, 'path', 'url_path', 'http_path'),
      method: value(row, 'method', 'http_method'),
      statusClass: Number.isFinite(status) ? `${Math.floor(status / 100)}xx` : undefined,
      count: count(row),
    };
  });
  return fields.length || messages.length || endpoints.length ? {
    ...context, recordsAnalyzed, fields, messages, endpoints, existingPolicies: [],
    limitations: ['Datadog counts come from SQL-style aggregate analysis; detail examples are separately bounded.'],
  } : null;
}

function mergeExamples(aggregate, details) {
  if (!aggregate) return details;
  if (!details) return aggregate;
  const detailFields = new Map(details.fields.map((field) => [field.name, field]));
  return {
    ...aggregate,
    fields: aggregate.fields.map((field) => ({
      ...field,
      examplesRedacted: detailFields.get(field.name)?.examplesRedacted || field.examplesRedacted,
      topValues: field.topValues || detailFields.get(field.name)?.topValues,
    })),
    messages: aggregate.messages.length ? aggregate.messages : details.messages,
    endpoints: aggregate.endpoints.length ? aggregate.endpoints : details.endpoints,
    limitations: [...new Set([...(aggregate.limitations || []), ...(details.limitations || [])])],
  };
}

export class DatadogAdapter {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.oauth = options.oauth;
    this.provider = 'datadog';
    this.readOnly = true;
  }

  async connect() {
    const config = resolveDatadogMcpConfig(this.env);
    this.client = await createMcpClient({
      label: 'Datadog', envPrefix: 'TELEMETRY_DIET_DATADOG',
      url: config.url,
      token: config.token,
      command: config.command,
      args: config.args,
      oauthClient: config.mode === 'hosted-oauth' ? this.oauth?.createClient('datadog', config.url) : undefined,
    });
    this.tools = await this.client.listTools();
    this.serviceTool = findTool(this.tools, ['search_datadog_services']);
    this.analysisTool = findTool(this.tools, ['analyze_datadog_logs']);
    this.searchTool = findTool(this.tools, ['search_datadog_logs']);
    if (!this.serviceTool || (!this.analysisTool && !this.searchTool)) {
      throw new Error('Datadog MCP must expose search_datadog_services and analyze_datadog_logs or search_datadog_logs.');
    }
    return { provider: this.provider, readOnly: true, serverInfo: this.client.serverInfo, tools: [this.serviceTool, this.analysisTool, this.searchTool].filter(Boolean).map(({ name }) => name) };
  }

  async discoverServices() {
    const intent = 'Discover services for a read-only telemetry policy analysis.';
    const result = await this.client.callTool(this.serviceTool.name, toolArgs(this.serviceTool, { intent, max_tokens: 3000 }));
    let services = extractServices(result);
    if (!services.length) {
      const logServices = await this.client.callTool(this.analysisTool.name, toolArgs(this.analysisTool, {
        sql_query: 'SELECT service, count(*) AS record_count FROM logs WHERE service IS NOT NULL GROUP BY service ORDER BY count(*) DESC LIMIT 100',
        query: 'SELECT service, count(*) AS record_count FROM logs WHERE service IS NOT NULL GROUP BY service ORDER BY count(*) DESC LIMIT 100',
        filter: '*', from: 'now-24h', to: 'now', max_tokens: 3000, intent,
      }));
      services = rowsFrom(logServices).map((row) => row.service).filter(Boolean);
    }
    const fallback = this.env.TELEMETRY_DIET_DATADOG_SERVICE;
    return services.length ? [...new Set(services)].sort() : fallback ? [fallback] : ['*'];
  }

  async getEnvironments() {
    return ['*', ...(this.env.TELEMETRY_DIET_DATADOG_ENVIRONMENTS || 'production,staging').split(',').map((value) => value.trim()).filter(Boolean)];
  }

  async analyze({ service, environment, timeWindow }) {
    const context = { provider: this.provider, service: service === '*' ? undefined : service, environment: environment === '*' ? undefined : environment, timeWindow };
    const baseValues = {
      service, environment, filter: providerQuery(service, environment), extra_columns: DATADOG_EXTRA_COLUMNS,
      start: timeWindow.start, end: timeWindow.end, from: timeWindow.start, to: timeWindow.end,
      max_tokens: 8000, intent: 'Analyze aggregate log noise, sensitive fields, and cardinality for a read-only policy preview.',
    };
    let aggregateSummaryResult = null;
    if (this.analysisTool) {
      const queries = datadogAggregateQueries(service, environment);
      const overviewRaw = await this.client.callTool(this.analysisTool.name, toolArgs(this.analysisTool, { ...baseValues, query: queries.overview, sql_query: queries.overview }));
      const overview = structuredDatadogPayload(overviewRaw);
      const alreadyNormalized = normalizedFromPayload(overview, context, { limitations: ['Provider aggregate shape was normalized locally.'] });
      if (alreadyNormalized?.fields.length && alreadyNormalized.messages.length && alreadyNormalized.endpoints.length) return alreadyNormalized;
      const fingerprintsRaw = await this.client.callTool(this.analysisTool.name, toolArgs(this.analysisTool, { ...baseValues, query: queries.fingerprints, sql_query: queries.fingerprints }));
      const fingerprints = structuredDatadogPayload(fingerprintsRaw);
      aggregateSummaryResult = aggregateSummary(overview, fingerprints, context) || alreadyNormalized;
      const riskyWithoutExamples = aggregateSummaryResult?.fields.some((field) =>
        /email|authorization|api.?key|secret|token|session/i.test(field.name) && !field.examplesRedacted?.length,
      );
      if (aggregateSummaryResult?.fields.length && aggregateSummaryResult.messages.length && aggregateSummaryResult.endpoints.length && !riskyWithoutExamples) {
        return aggregateSummaryResult;
      }
    }
    if (!this.searchTool) throw new Error('Datadog aggregate did not include normalizable fields and search_datadog_logs is unavailable.');
    const detailsRaw = await this.client.callTool(this.searchTool.name, toolArgs(this.searchTool, {
      ...baseValues, query: providerQuery(service, environment), max_tokens: 3000,
      extra_fields: ['request.id', 'session.id', 'user.id', 'user.email', 'http.request.header.authorization', 'http.url_details.path', 'http.status_code', 'http.method'],
      intent: 'Fetch a tiny bounded set of examples for local redaction after aggregate analysis.',
    }));
    const details = structuredDatadogPayload(detailsRaw);
    const normalizedDetails = normalizedFromPayload(details, context, {
      recordLimit: 10,
      limitations: ['Examples use at most 10 log events permitted by the current Datadog RBAC scope; raw events are discarded after local redaction.'],
    });
    const result = mergeExamples(aggregateSummaryResult, normalizedDetails);
    return result || {
      ...context, recordsAnalyzed: 0, fields: [], messages: [], endpoints: [], existingPolicies: [],
      limitations: ['Datadog returned no logs for the selected scope and time window.'],
    };
  }

  close() { return this.client?.close(); }
}
