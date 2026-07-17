#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';

const output = execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.js',
]);
const files = output.toString('utf8').split('\0').filter(Boolean);

for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${path}\n`);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax-checked ${files.length} JavaScript files.`);
