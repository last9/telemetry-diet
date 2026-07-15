export function fakeOAuthClient(tools, responses) {
  const calls = [];
  const client = {
    serverInfo: { name: 'last9-read-only' },
    async connect() { return this; },
    async listTools() { return tools; },
    async callTool(name, args) {
      calls.push({ name, args });
      const response = responses[name];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(args) : response;
    },
    async close() {},
  };
  return { calls, oauth: { createClient: () => client } };
}
