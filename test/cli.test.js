import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'bin', 'telemetry-diet.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function runCli(args, environment = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PORT: '', ...environment },
  });
}

test('CLI help describes the local read-only command without starting a server', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: telemetry-diet/);
  assert.match(result.stdout, /local read-only MCP policy workbench/);
  assert.equal(result.stderr, '');
});

test('CLI help remains available when the configured runtime port is invalid', () => {
  const result = runCli(['--help'], { PORT: 'invalid' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: telemetry-diet/);
  assert.equal(result.stderr, '');
});

test('CLI reports the package version', () => {
  const result = runCli(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `Telemetry Diet ${version}\n`);
  assert.equal(result.stderr, '');
});

test('CLI rejects unknown options without exposing a stack trace', () => {
  const result = runCli(['--write-production']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Telemetry Diet: Unknown option: --write-production\n');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('CLI rejects invalid ports without exposing a stack trace', () => {
  const result = runCli(['--port', '0']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Telemetry Diet: --port must be a valid TCP port.\n');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
