#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED_FILES = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'bin/sample-mcp.js',
  'bin/telemetry-diet.js',
  'package.json',
  'schemas/telemetry-diet.last9-draft.v1.schema.json',
  'scripts/validate-artifacts.js',
  'web/app.js',
  'web/index.html',
  'web/styles.css',
];
const FORBIDDEN_PATH = /^(?:\.github|docs|test)\/|(?:^|\/)workbench-redesign-|(?:^|\/)\.telemetry-diet(?:\.json)?$/;
const MAX_PACKED_BYTES = 250_000;

const validationDir = mkdtempSync(join(tmpdir(), 'telemetry-diet-pack-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, [
    'pack', '--dry-run', '--json', '--cache', join(validationDir, 'npm-cache'),
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'npm pack --dry-run failed.');

  const [details] = JSON.parse(result.stdout);
  const files = new Map(details.files.map((file) => [file.path, file]));
  const missing = REQUIRED_FILES.filter((path) => !files.has(path));
  const forbidden = [...files.keys()].filter((path) => FORBIDDEN_PATH.test(path));
  if (missing.length) throw new Error(`npm package is missing required files: ${missing.join(', ')}`);
  if (forbidden.length) throw new Error(`npm package contains private or development files: ${forbidden.join(', ')}`);
  if (details.size > MAX_PACKED_BYTES) throw new Error(`npm package exceeds ${MAX_PACKED_BYTES} packed bytes.`);
  for (const path of ['bin/sample-mcp.js', 'bin/telemetry-diet.js']) {
    if ((files.get(path).mode & 0o111) === 0) throw new Error(`${path} is not executable in the npm package.`);
  }

  console.log(`Validated npm package: ${details.entryCount} files, ${details.size} packed bytes.`);
} finally {
  rmSync(validationDir, { recursive: true, force: true });
}
