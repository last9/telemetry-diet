const WRITE_TOOL = /(?:^|[_-])(add|apply|approve|archive|assign|cancel|close|create|delete|deploy|destroy|disable|drop|edit|enable|execute|grant|import|install|kill|mutate|patch|pause|post|prune|publish|purge|put|remove|reset|restart|revoke|rotate|run|save|send|set|start|stop|submit|trigger|truncate|uninstall|update|upsert|write)(?:$|[_-])/i;
const READ_TOOL = /(?:^|[_-])(describe|export|fetch|get|inspect|list|query|read|search|values)(?:$|[_-])/i;

export function hasReadToolVerb(name) {
  return READ_TOOL.test(String(name || ''));
}

export function isSafeLast9ReadTool(tool, exactAliases = []) {
  if (!tool?.name || WRITE_TOOL.test(tool.name)) return false;
  if (tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false) return false;
  const name = String(tool.name).toLowerCase();
  return exactAliases.includes(name) || tool.annotations?.readOnlyHint === true;
}
