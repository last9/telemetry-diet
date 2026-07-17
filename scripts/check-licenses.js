#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const ALLOWED_LICENSES = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
]);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['query', '*', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'npm query failed.');

const packages = JSON.parse(result.stdout);
const failures = [];
const counts = new Map();
for (const dependency of packages) {
  const license = typeof dependency.license === 'string' ? dependency.license : null;
  if (!license || !ALLOWED_LICENSES.has(license)) {
    failures.push(`${dependency.name}@${dependency.version}: ${license || 'missing license'}`);
    continue;
  }
  counts.set(license, (counts.get(license) || 0) + 1);
}

if (failures.length) {
  throw new Error(`Dependency license review required:\n${failures.join('\n')}`);
}

const summary = [...counts]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, count]) => `${license}=${count}`)
  .join(', ');
console.log(`Validated ${packages.length} installed package licenses (${summary}).`);
