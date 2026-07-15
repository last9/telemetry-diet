import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../mcp/client.js';
import { extractEnvironments, extractServices } from './helpers.js';

export class SampleAdapter {
  constructor() {
    this.provider = 'sample';
    this.readOnly = true;
  }

  async connect() {
    const serverPath = fileURLToPath(new URL('../../bin/sample-mcp.js', import.meta.url));
    this.client = await new StdioMcpClient(process.execPath, [serverPath]).connect();
    this.tools = await this.client.listTools();
    return { provider: this.provider, readOnly: true, serverInfo: this.client.serverInfo };
  }

  async discoverServices() {
    const result = await this.client.callTool('search_services');
    return extractServices(result);
  }

  async getEnvironments(service) {
    const result = await this.client.callTool('get_service_environments', { service });
    return extractEnvironments(result);
  }

  async analyze({ service, environment, timeWindow }) {
    return this.client.callTool('analyze_logs', { service, environment, timeWindow });
  }

  close() { return this.client?.close(); }
}
