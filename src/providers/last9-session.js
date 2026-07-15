import { createMcpClient } from '../mcp/client.js';
import { toolArgs } from './helpers.js';
import { Last9Adapter, resolveLast9McpConfig } from './last9.js';
import { environmentsFromLast9, servicesFromLast9Summary } from './last9-normalize.js';
import { isSafeLast9ReadTool } from './last9-tool-safety.js';

const SESSION_EXACT_ALIASES = [
  'get_service_summary',
  'get_service_environments',
  'get_service_logs',
  'get_metric_names',
  'list_metric_names',
  'read_metric_names',
  'get_metrics',
  'list_metrics',
  'prometheus_label_values',
  'get_metric_label_values',
  'get_dashboards',
  'list_dashboards',
  'get_native_dashboards',
  'list_native_dashboards',
  'get_last9_dashboards',
  'get_grafana_dashboards',
  'list_grafana_dashboards',
  'get_embedded_grafana_dashboards',
  'list_embedded_grafana_dashboards',
  'get_alert_rules',
  'list_alert_rules',
  'get_alerts',
  'list_alerts',
  'get_alert_definitions',
  'list_alert_definitions',
  'get_entity_indicators',
  'list_entity_indicators',
  'get_indicators',
  'list_indicators',
  'get_entity_kpis',
  'list_entity_kpis',
  'analyze_trace_aggregates',
  'get_trace_aggregates',
  'get_span_statistics',
  'get_service_traces',
  'search_traces',
];

function exactTool(tools, name) {
  return tools.find((tool) => tool.name.toLowerCase() === name);
}

export class Last9SessionAdapter {
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
    const advertised = await this.client.listTools();
    this.tools = advertised.filter((tool) => isSafeLast9ReadTool(tool, SESSION_EXACT_ALIASES));
    if (!this.tools.length) throw new Error('Last9 MCP must expose at least one read-only telemetry capability.');
    this.summaryTool = exactTool(this.tools, 'get_service_summary');
    this.environmentsTool = exactTool(this.tools, 'get_service_environments');
    return {
      provider: this.provider,
      readOnly: true,
      serverInfo: this.client.serverInfo,
      tools: this.tools.map(({ name }) => name),
    };
  }

  async discoverServices() {
    const configured = this.env.TELEMETRY_DIET_LAST9_SERVICE;
    if (configured) return [configured];
    if (!this.summaryTool) return [];
    if ((this.summaryTool.inputSchema?.required || []).some((key) => /service/i.test(key))) return [];
    const result = await this.client.callTool(this.summaryTool.name, toolArgs(this.summaryTool, {
      query: '*',
      limit: 100,
      lookback_minutes: 10080,
    }));
    return servicesFromLast9Summary(result);
  }

  async getEnvironments(service) {
    if (!this.environmentsTool) return ['*', ...(this.env.TELEMETRY_DIET_LAST9_ENVIRONMENTS || 'production').split(',')];
    const result = await this.client.callTool(this.environmentsTool.name, toolArgs(this.environmentsTool, { service, query: service }));
    return ['*', ...environmentsFromLast9(result).filter((value) => value !== '*')];
  }

  async analyze(scope) {
    if (!this.logAdapter) {
      const adapter = new Last9Adapter(this.env, { oauth: this.oauth });
      try {
        await adapter.connect();
        this.logAdapter = adapter;
      } catch (error) {
        await adapter.close();
        throw error;
      }
    }
    return this.logAdapter.analyze(scope);
  }

  async close() {
    await Promise.all([this.client?.close(), this.logAdapter?.close()]);
  }
}
