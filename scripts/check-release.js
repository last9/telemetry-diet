#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const failures = [];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (manifest.name !== 'telemetry-diet') failures.push('package name must be telemetry-diet');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  failures.push('package version must be valid SemVer');
}
if (manifest.private === true) failures.push('package must not be private');
if (manifest.license !== 'Apache-2.0') failures.push('package license must be Apache-2.0');
if (manifest.repository?.url !== 'git+https://github.com/last9/telemetry-diet.git') {
  failures.push('package repository must match the public GitHub repository exactly');
}
if (manifest.publishConfig?.access !== 'public') failures.push('publishConfig.access must be public');
if (manifest.publishConfig?.provenance !== true) failures.push('publishConfig.provenance must be true');
if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  failures.push('publishConfig.registry must be the public npm registry');
}
if (!changelog.includes(`## [${manifest.version}] - `)) {
  failures.push(`CHANGELOG.md is missing version ${manifest.version}`);
}

for (const file of ['LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md']) {
  if (!existsSync(new URL(`../${file}`, import.meta.url))) failures.push(`${file} is missing`);
}

const tag = argumentValue('--tag');
if (tag != null && tag !== `v${manifest.version}`) {
  failures.push(`release tag ${tag || '(missing)'} does not match v${manifest.version}`);
}

if (failures.length) throw new Error(`Release validation failed:\n${failures.join('\n')}`);
console.log(`Validated release metadata for telemetry-diet@${manifest.version}${tag ? ` (${tag})` : ''}.`);
