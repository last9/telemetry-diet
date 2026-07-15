import { createMcpClient } from '../mcp/client.js';
import { resolveLast9McpConfig } from './last9.js';
import { hasReadToolVerb, isSafeLast9ReadTool } from './last9-tool-safety.js';

const QUERY_KEYS = new Set(['expr', 'expression', 'promql', 'query']);
const TOOL_RESULT_LIMIT = 1000;
const MAX_METRIC_NAMES = TOOL_RESULT_LIMIT;
const MAX_REFERENCE_RECORDS = TOOL_RESULT_LIMIT * 4;
const MAX_EVIDENCE_STRING_LENGTH = 1024;
const MAX_QUERY_LENGTH = 16 * 1024;
const BOUNDS_ERROR = 'Last9 metric usage response exceeded safe analysis bounds.';

const CAPABILITIES = {
  inventory: {
    label: 'metric-name inventory',
    aliases: ['get_metric_names', 'list_metric_names', 'read_metric_names', 'get_metrics', 'list_metrics', 'prometheus_label_values', 'get_metric_label_values'],
  },
  dashboards: {
    label: 'native dashboard definitions',
    aliases: ['get_dashboards', 'list_dashboards', 'get_native_dashboards', 'list_native_dashboards', 'get_last9_dashboards'],
  },
  grafana: {
    label: 'embedded Grafana dashboard definitions',
    aliases: ['get_grafana_dashboards', 'list_grafana_dashboards', 'get_embedded_grafana_dashboards', 'list_embedded_grafana_dashboards'],
  },
  alerts: {
    label: 'alert definitions',
    aliases: ['get_alert_rules', 'list_alert_rules', 'get_alerts', 'list_alerts', 'get_alert_definitions', 'list_alert_definitions'],
  },
  indicators: {
    label: 'entity indicator queries',
    aliases: ['get_entity_indicators', 'list_entity_indicators', 'get_indicators', 'list_indicators', 'get_entity_kpis', 'list_entity_kpis'],
  },
};

function normalizedWords(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function failBounds() {
  throw new Error(BOUNDS_ERROR);
}

function boundedString(value, maxLength = MAX_EVIDENCE_STRING_LENGTH) {
  const result = String(value);
  if (result.length > maxLength) failBounds();
  return result;
}

function appendBounded(output, value, maxLength = MAX_REFERENCE_RECORDS) {
  if (output.length >= maxLength) failBounds();
  output.push(value);
}

function appendQuery(output, value) {
  const query = value.trim();
  if (query.length > MAX_QUERY_LENGTH) failBounds();
  appendBounded(output, query);
}

function appendReference(output, reference) {
  const bounded = {
    ...reference,
    sourceId: boundedString(reference.sourceId),
    sourceName: boundedString(reference.sourceName),
    query: boundedString(reference.query, MAX_QUERY_LENGTH),
    updatedAt: reference.updatedAt == null ? null : boundedString(reference.updatedAt),
  };
  appendBounded(output, bounded);
}

function toolScore(tool, capability) {
  const spec = CAPABILITIES[capability];
  if (!isSafeLast9ReadTool(tool, spec.aliases)) return -1;
  const name = tool.name.toLowerCase();
  const exact = spec.aliases.findIndex((alias) => name === alias);
  if (exact !== -1) return 1000 - exact;
  const suffix = spec.aliases.findIndex((alias) => name.endsWith(`_${alias}`));
  if (suffix !== -1) return 900 - suffix;
  if (!hasReadToolVerb(name)) return -1;

  const haystack = normalizedWords(`${tool.name} ${tool.title || ''} ${tool.description || ''}`);
  const has = (pattern) => pattern.test(haystack);
  if (capability === 'inventory') {
    if (!has(/\bmetrics?\b/) || !has(/\b(catalog|inventory|labels?|names?|series)\b/)) return -1;
    if (has(/\b(dashboard|alert|indicator|kpi)\b/)) return -1;
    return 100 + (has(/\b(read|fetch|get|list|query|search)\b/) ? 20 : 0);
  }
  if (capability === 'dashboards') {
    if (!has(/\bdashboards?\b/) || has(/\bgrafana\b/)) return -1;
    return 100 + (has(/\b(native|last9|definitions?|panels?|queries)\b/) ? 20 : 0);
  }
  if (capability === 'grafana') {
    if (!has(/\bgrafana\b/) || !has(/\bdashboards?\b/)) return -1;
    return 130;
  }
  if (capability === 'alerts') {
    if (!has(/\balerts?\b/) || !has(/\b(definitions?|queries|rules?)\b/)) return -1;
    return 120;
  }
  if (capability === 'indicators') {
    if (!has(/\b(indicators?|kpis?)\b/) || !has(/\b(entities?|queries|definitions?)\b/)) return -1;
    return 120;
  }
  return -1;
}

function resolveTool(tools, capability) {
  return tools
    .map((tool) => ({ tool, score: toolScore(tool, capability) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.tool;
}

function toolArguments(tool, capability, values = {}) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const args = {};
  for (const key of new Set([...Object.keys(properties), ...required])) {
    if (/^(?:limit|count|page_?size|size)$/i.test(key)) args[key] = TOOL_RESULT_LIMIT;
    else if (/^(?:entity_?ids)$/i.test(key) && values.entityIds) args[key] = values.entityIds;
    else if (/^(?:entity_?id)$/i.test(key) && values.entityId) args[key] = values.entityId;
    else if (/^(?:label|label_?name)$/i.test(key) && capability === 'inventory') args[key] = '__name__';
    else if (/^(?:include_?definitions?|include_?details?|full)$/i.test(key)) args[key] = true;
    else if (/query|expr|search|filter/i.test(key)) {
      args[key] = capability === 'inventory' ? 'count by (__name__)({__name__!=""})' : '*';
    }
  }
  return args;
}

function metricNamesFrom(payload) {
  const names = new Set();
  const valid = (value) => typeof value === 'string' && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value);
  const add = (value) => {
    if (!valid(value)) return;
    boundedString(value);
    if (!names.has(value) && names.size >= MAX_METRIC_NAMES) failBounds();
    names.add(value);
  };
  const visit = (value, acceptStrings = false) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, acceptStrings);
      return;
    }
    if (valid(value)) {
      if (acceptStrings) add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['__name__', 'metric_name', 'metricName'].includes(key) && valid(item)) add(item);
      else if (key === 'metric' && item && typeof item === 'object' && valid(item.__name__)) add(item.__name__);
      else if (key === 'name' && acceptStrings && valid(item)) add(item);
      else visit(item, /^(?:data|result|values|names|metrics|metric_?names)$/i.test(key));
    }
  };
  visit(payload, Array.isArray(payload));
  return [...names].sort();
}

function firstValue(value, keys) {
  for (const key of keys) if (value?.[key] != null && value[key] !== '') return value[key];
  return undefined;
}

function queryStrings(value, depth = 0, output = []) {
  if (!value || typeof value !== 'object' || depth > 8) return output;
  for (const [key, item] of Object.entries(value)) {
    if (QUERY_KEYS.has(key) && typeof item === 'string' && item.trim()) appendQuery(output, item);
    else if (item && typeof item === 'object') queryStrings(item, depth + 1, output);
  }
  return output;
}

function ownedQueryStrings(value) {
  const output = [];
  for (const key of QUERY_KEYS) {
    const item = value?.[key];
    if (typeof item === 'string' && item.trim()) appendQuery(output, item);
    else if (item && typeof item === 'object') queryStrings(item, 0, output);
  }
  if (value?.definition && typeof value.definition === 'object') queryStrings(value.definition, 0, output);
  return [...new Set(output)];
}

function dashboardDocuments(payload) {
  const documents = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.dashboard && typeof value.dashboard === 'object') {
      appendBounded(documents, {
        ...value.dashboard,
        id: firstValue(value, ['id', 'uid']) ?? firstValue(value.dashboard, ['id', 'uid']),
        name: firstValue(value, ['name', 'title']) ?? firstValue(value.dashboard, ['name', 'title']),
        updatedAt: firstValue(value, ['updated_at', 'updatedAt']) ?? value.meta?.updated ?? firstValue(value.dashboard, ['updated_at', 'updatedAt']),
      });
      return;
    }
    if (Array.isArray(value.panels)) {
      appendBounded(documents, value);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  return documents;
}

function panelQueryEntries(panel) {
  const entries = [];
  for (const key of QUERY_KEYS) {
    const value = panel?.[key];
    if (typeof value === 'string' && value.trim()) appendBounded(entries, { query: boundedString(value.trim(), MAX_QUERY_LENGTH) });
    else if (value && typeof value === 'object') {
      queryStrings(value).forEach((query) => appendBounded(entries, { query }));
    }
  }
  for (const collectionKey of ['targets', 'queries']) {
    const collection = panel?.[collectionKey];
    if (!Array.isArray(collection)) continue;
    collection.forEach((item, index) => {
      const label = firstValue(item, ['refId', 'ref_id', 'name', 'id']) ?? `${collectionKey.slice(0, -1)} ${index + 1}`;
      queryStrings(item).forEach((query) => appendBounded(entries, { label: boundedString(label), query }));
    });
  }
  const seen = new Set();
  return entries.filter(({ label, query }) => {
    const key = `${label || ''}\u0000${query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dashboardReferences(payload) {
  const references = [];
  for (const dashboard of dashboardDocuments(payload)) {
    const dashboardId = String(firstValue(dashboard, ['id', 'uid']) ?? 'unknown-dashboard');
    const dashboardName = String(firstValue(dashboard, ['name', 'title']) ?? dashboardId);
    const updatedAt = firstValue(dashboard, ['updated_at', 'updatedAt']) ?? dashboard.meta?.updated ?? null;
    const visitPanel = (panel, ancestors = []) => {
      if (!panel || typeof panel !== 'object') return;
      const panelId = firstValue(panel, ['id', 'uid']);
      const panelName = String(firstValue(panel, ['title', 'name']) ?? (panelId != null ? `Panel ${panelId}` : 'Panel'));
      const path = [...ancestors, panelName];
      for (const entry of panelQueryEntries(panel)) {
        appendReference(references, {
          kind: 'dashboard',
          sourceId: dashboardId,
          sourceName: [dashboardName, ...path, entry.label].filter(Boolean).join(' > '),
          query: entry.query,
          updatedAt,
        });
      }
      (Array.isArray(panel.panels) ? panel.panels : []).forEach((child) => visitPanel(child, path));
    };
    (Array.isArray(dashboard.panels) ? dashboard.panels : []).forEach((panel) => visitPanel(panel));
  }
  return references;
}

function alertReferences(payload) {
  const references = [];
  const visit = (value, groupName) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, groupName));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.rules)) {
      const nextGroup = String(firstValue(value, ['name', 'title', 'group_name', 'groupName']) ?? groupName ?? 'Alerts');
      value.rules.forEach((rule) => visit(rule, nextGroup));
      for (const [key, item] of Object.entries(value)) if (key !== 'rules') visit(item, groupName);
      return;
    }
    const queries = ownedQueryStrings(value);
    if (queries.length) {
      const id = String(firstValue(value, ['id', 'uid']) ?? 'unknown-alert');
      const name = String(firstValue(value, ['name', 'alert', 'title']) ?? id);
      const updatedAt = firstValue(value, ['updated_at', 'updatedAt']) ?? null;
      queries.forEach((query) => appendReference(references, {
        kind: 'alert', sourceId: id,
        sourceName: [groupName, name].filter(Boolean).join(' > '),
        query, updatedAt,
      }));
      return;
    }
    Object.values(value).forEach((item) => visit(item, groupName));
  };
  visit(payload);
  return references;
}

function entityIdsFrom(payload) {
  const ids = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^entity_?id$/i.test(key) && item != null && item !== '') {
        const id = boundedString(item);
        if (!ids.has(id) && ids.size >= MAX_REFERENCE_RECORDS) failBounds();
        ids.add(id);
      }
      else visit(item);
    }
  };
  visit(payload);
  return [...ids];
}

function indicatorReferences(payload) {
  const references = [];
  const visit = (value, entity = {}) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, entity));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const collection = Array.isArray(value.kpis) ? value.kpis : Array.isArray(value.indicators) ? value.indicators : null;
    if (collection) {
      const nextEntity = {
        id: firstValue(value, ['entity_id', 'entityId', 'id']) ?? entity.id,
        name: firstValue(value, ['entity_name', 'entityName', 'name', 'title']) ?? entity.name,
      };
      collection.forEach((item) => visit(item, nextEntity));
      return;
    }
    const queries = ownedQueryStrings(value);
    if (queries.length) {
      const indicatorId = String(firstValue(value, ['id', 'uid']) ?? entity.id ?? 'unknown-indicator');
      const indicatorName = String(firstValue(value, ['name', 'title']) ?? indicatorId);
      const entityName = firstValue(value, ['entity_name', 'entityName']) ?? entity.name;
      const updatedAt = firstValue(value, ['updated_at', 'updatedAt']) ?? null;
      queries.forEach((query) => appendReference(references, {
        kind: 'indicator', sourceId: indicatorId,
        sourceName: [entityName, indicatorName].filter(Boolean).join(' > '),
        query, updatedAt,
      }));
      return;
    }
    Object.values(value).forEach((item) => visit(item, entity));
  };
  visit(payload);
  return references;
}

export class Last9MetricsAdapter {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.oauth = options.oauth;
    this.now = options.now || (() => new Date());
    this.provider = 'last9';
    this.readOnly = true;
  }

  async connect() {
    const config = resolveLast9McpConfig(this.env);
    if (!config.configured) throw new Error('Last9 organization is not configured. Set TELEMETRY_DIET_LAST9_ORG_SLUG once, then use provider login.');
    this.client = await createMcpClient({
      label: 'Last9', envPrefix: 'TELEMETRY_DIET_LAST9',
      url: config.url, token: config.token, command: config.command, args: config.args,
      timeout: 180000,
      oauthClient: config.mode === 'hosted-oauth' ? this.oauth?.createClient('last9', config.url) : undefined,
    });
    this.tools = await this.client.listTools();
    this.capabilities = Object.fromEntries(Object.keys(CAPABILITIES).map((capability) => [capability, resolveTool(this.tools, capability)]));
    if (!this.capabilities.inventory) {
      throw new Error('Last9 MCP must expose a read-only metric-name inventory capability.');
    }
    const referenceTools = ['dashboards', 'grafana', 'alerts', 'indicators'].map((key) => this.capabilities[key]).filter(Boolean);
    if (!referenceTools.length) {
      throw new Error('Last9 MCP must expose at least one read-only metric-reference capability (native dashboards, embedded Grafana dashboards, alerts, or entity indicators).');
    }
    return {
      provider: this.provider,
      readOnly: true,
      serverInfo: this.client.serverInfo,
      tools: Object.values(this.capabilities).filter(Boolean).map(({ name }) => name),
    };
  }

  async callCapability(capability, values) {
    const tool = this.capabilities[capability];
    return this.client.callTool(tool.name, toolArguments(tool, capability, values));
  }

  async collect() {
    if (!this.client || !this.capabilities) throw new Error('Connect the Last9 metrics adapter before collecting.');
    const warnings = [];
    let inventory;
    try {
      inventory = await this.callCapability('inventory');
    } catch {
      throw new Error('Last9 metric-name inventory could not be collected; refusing an incomplete analysis.');
    }
    const metricNames = metricNamesFrom(inventory);
    if (!metricNames.length) throw new Error('Last9 metric-name inventory response contained no metric names; refusing an incomplete analysis.');

    const payloads = {};
    let successfulReferenceScans = 0;
    for (const capability of ['dashboards', 'grafana', 'alerts']) {
      const tool = this.capabilities[capability];
      if (!tool) {
        warnings.push(`Last9 MCP does not advertise ${CAPABILITIES[capability].label}; those references were not scanned.`);
        continue;
      }
      try {
        payloads[capability] = await this.callCapability(capability);
        successfulReferenceScans += 1;
      } catch {
        warnings.push(`Could not scan ${CAPABILITIES[capability].label}; the read request failed.`);
      }
    }

    const indicatorTool = this.capabilities.indicators;
    if (!indicatorTool) {
      warnings.push(`Last9 MCP does not advertise ${CAPABILITIES.indicators.label}; those references were not scanned.`);
    } else {
      try {
        const entityIds = entityIdsFrom(payloads.alerts);
        const required = new Set(indicatorTool.inputSchema?.required || []);
        const needsSingleEntity = [...required].some((key) => /^entity_?id$/i.test(key));
        if (needsSingleEntity && entityIds.length) {
          payloads.indicators = [];
          for (const entityId of entityIds) payloads.indicators.push(await this.callCapability('indicators', { entityId }));
          successfulReferenceScans += 1;
        } else if (needsSingleEntity) {
          payloads.indicators = [];
          warnings.push('Entity indicators require alert entity IDs, but none were advertised by the scanned alerts.');
        } else {
          payloads.indicators = await this.callCapability('indicators', { entityIds });
          successfulReferenceScans += 1;
        }
      } catch {
        warnings.push(`Could not scan ${CAPABILITIES.indicators.label}; the read request failed.`);
      }
    }

    if (!successfulReferenceScans) {
      throw new Error('No Last9 metric-reference capability completed successfully; refusing an incomplete analysis.');
    }

    const references = [];
    for (const normalized of [
      dashboardReferences(payloads.dashboards),
      dashboardReferences(payloads.grafana),
      alertReferences(payloads.alerts),
      indicatorReferences(payloads.indicators),
    ]) {
      normalized.forEach((reference) => appendBounded(references, reference));
    }

    return {
      capturedAt: this.now().toISOString(),
      metricNames,
      references,
      warnings,
    };
  }

  close() { return this.client?.close(); }
}
