import { createMcpClient } from '../mcp/client.js';
import { extractEnvironments, extractServices, findTool, normalizedFromPayload, providerQuery, toolArgs } from './helpers.js';

export function resolveLast9McpConfig(env = process.env) {
  const url = env.TELEMETRY_DIET_LAST9_MCP_URL;
  const explicitCommand = env.TELEMETRY_DIET_LAST9_MCP_COMMAND;
  const orgSlug = env.TELEMETRY_DIET_LAST9_ORG_SLUG;
  const hostedUrl = orgSlug ? `https://app.last9.io/api/v4/organizations/${orgSlug}/mcp` : undefined;
  return {
    url: explicitCommand ? undefined : (url || hostedUrl),
    token: env.TELEMETRY_DIET_LAST9_MCP_TOKEN,
    command: explicitCommand,
    args: env.TELEMETRY_DIET_LAST9_MCP_ARGS,
    configured: Boolean(url || explicitCommand || hostedUrl),
    mode: explicitCommand ? 'custom-command' : env.TELEMETRY_DIET_LAST9_MCP_TOKEN ? 'http-token' : hostedUrl || url ? 'hosted-oauth' : 'not-configured',
    orgSlug,
  };
}

export class Last9Adapter {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.oauth = options.oauth;
    this.provider = 'last9';
    this.readOnly = true;
  }

  async connect() {
    const config = resolveLast9McpConfig(this.env);
    if (!config.configured) throw new Error('Last9 organization is not configured. Set TELEMETRY_DIET_LAST9_ORG_SLUG once, then use provider login.');
    this.client = await createMcpClient({
      label: 'Last9', envPrefix: 'TELEMETRY_DIET_LAST9',
      url: config.url,
      token: config.token,
      command: config.command,
      args: config.args,
      timeout: 180000,
      oauthClient: config.mode === 'hosted-oauth' ? this.oauth?.createClient('last9', config.url) : undefined,
    });
    this.tools = await this.client.listTools();
    this.summaryTool = findTool(this.tools, ['get_service_summary']);
    this.environmentsTool = findTool(this.tools, ['get_service_environments']);
    this.logsTool = findTool(this.tools, ['get_service_logs']);
    this.attributesTool = findTool(this.tools, ['get_log_attributes']);
    this.rulesTool = findTool(this.tools, ['get_drop_rules']);
    this.didYouMeanTool = findTool(this.tools, ['did_you_mean']);
    if (!this.summaryTool || !this.logsTool) throw new Error('Last9 MCP must expose get_service_summary and get_service_logs.');
    return {
      provider: this.provider, readOnly: true, serverInfo: this.client.serverInfo,
      tools: [this.summaryTool, this.environmentsTool, this.logsTool, this.attributesTool, this.rulesTool].filter(Boolean).map(({ name }) => name),
    };
  }

  async discoverServices() {
    const configured = this.env.TELEMETRY_DIET_LAST9_SERVICE;
    if (configured) return [configured];
    const values = { query: configured || '*', service: configured, limit: 100, lookback_minutes: 10080 };
    if (!(this.summaryTool.inputSchema?.required || []).some((key) => /service/i.test(key))) {
      const result = await this.client.callTool(this.summaryTool.name, toolArgs(this.summaryTool, values));
      return extractServices(result);
    }
    return [];
  }

  async getEnvironments(service) {
    if (!this.environmentsTool) return (this.env.TELEMETRY_DIET_LAST9_ENVIRONMENTS || 'production').split(',');
    const result = await this.client.callTool(this.environmentsTool.name, toolArgs(this.environmentsTool, { service, query: service }));
    return extractEnvironments(result);
  }

  async analyze({ service, environment, timeWindow }) {
    const context = { provider: this.provider, service, environment, timeWindow };
    const values = {
      service, environment, query: providerQuery(service, environment),
      start: timeWindow.start, end: timeWindow.end, from: timeWindow.start, to: timeWindow.end, limit: 200,
    };
    const [serviceSummary, attributes, rules] = await Promise.all([
      this.client.callTool(this.summaryTool.name, toolArgs(this.summaryTool, values)),
      this.attributesTool ? this.client.callTool(this.attributesTool.name, toolArgs(this.attributesTool, values)) : null,
      this.rulesTool ? this.client.callTool(this.rulesTool.name, toolArgs(this.rulesTool, values)) : null,
    ]);
    const rawRules = Array.isArray(rules) ? rules : (rules?.rules || rules?.drop_rules || []);
    const existingPolicies = rawRules.map((rule) => ({
      provider: 'last9', name: rule.name || rule.id || 'Existing drop rule', type: rule.type || 'drop', summary: rule.summary || rule.description || JSON.stringify(rule.filters || {}),
    }));
    for (const aggregate of [attributes, serviceSummary]) {
      const normalized = normalizedFromPayload(aggregate, context, { existingPolicies, limitations: ['Last9 aggregates were normalized locally; draft rules are never applied.'] });
      if (normalized?.fields.length && (normalized.messages.length || normalized.endpoints.length)) return normalized;
    }
    const logs = await this.client.callTool(this.logsTool.name, toolArgs(this.logsTool, values));
    const normalized = normalizedFromPayload(logs, context, { existingPolicies, limitations: ['Field ratios are based on at most 200 records returned by Last9 MCP.'] });
    if (!normalized) throw new Error('Last9 MCP response did not contain structured log records or a normalized aggregate.');
    return normalized;
  }

  close() { return this.client?.close(); }
}
