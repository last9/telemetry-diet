#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTelemetryDietServer, listen } from '../src/server.js';

try {
  const localConfig = JSON.parse(readFileSync(join(process.cwd(), '.telemetry-diet.json'), 'utf8'));
  if (localConfig.last9OrgSlug && !process.env.TELEMETRY_DIET_LAST9_ORG_SLUG) {
    process.env.TELEMETRY_DIET_LAST9_ORG_SLUG = localConfig.last9OrgSlug;
  }
} catch { /* Local configuration is optional. */ }

function parseArgs(argv) {
  const result = { host: '127.0.0.1', port: Number(process.env.PORT || 4545), open: true };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--port') result.port = Number(argv[++index]);
    else if (argv[index] === '--host') result.host = argv[++index];
    else if (argv[index] === '--no-open') result.open = false;
    else if (argv[index] === '--help' || argv[index] === '-h') result.help = true;
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('--port must be a valid TCP port.');
  return result;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Telemetry Diet\n\nUsage: telemetry-diet [--port 4545] [--host 127.0.0.1] [--no-open]\n\nStarts the local read-only MCP policy workbench.`);
  process.exit(0);
}

const server = createTelemetryDietServer();
const address = await listen(server, options);
server.setBaseUrl(address.url);
console.log(`Telemetry Diet is running at ${address.url}`);
console.log('Read-only by default. No production policy writes are available.');
if (options.open) openBrowser(address.url);

async function shutdown() {
  await server.closeProviders();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
