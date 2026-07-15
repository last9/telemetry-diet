export class McpServer {
  constructor({ name, version, tools }) {
    this.name = name;
    this.version = version;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  start(input = process.stdin, output = process.stdout) {
    input.setEncoding('utf8');
    let buffer = '';
    input.on('data', async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const response = await this.handle(message);
          if (response) output.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } })}\n`);
        }
      }
    });
  }

  async handle(message) {
    if (!Object.hasOwn(message, 'id')) return null;
    const base = { jsonrpc: '2.0', id: message.id };
    try {
      if (message.method === 'initialize') {
        return { ...base, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.name, version: this.version } } };
      }
      if (message.method === 'ping') return { ...base, result: {} };
      if (message.method === 'tools/list') {
        return { ...base, result: { tools: [...this.tools.values()].map(({ handler, ...definition }) => definition) } };
      }
      if (message.method === 'tools/call') {
        const tool = this.tools.get(message.params?.name);
        if (!tool) throw new Error(`Unknown tool: ${message.params?.name}`);
        const data = await tool.handler(message.params?.arguments || {});
        return { ...base, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
      }
      return { ...base, error: { code: -32601, message: `Method not found: ${message.method}` } };
    } catch (error) {
      return { ...base, result: { content: [{ type: 'text', text: error.message }], isError: true } };
    }
  }
}
