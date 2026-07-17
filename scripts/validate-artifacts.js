#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { analyzeTelemetry } from '../src/core/analyzer.js';
import { generateArtifacts } from '../src/core/report.js';
import { getScenarioSummary } from '../src/sample/scenarios.js';
import { getSampleTraceIntelligenceInput } from '../src/sample/trace-intelligence.js';
import { analyzeTraceIntelligence } from '../src/trace-intelligence/index.js';

const TIME_WINDOW = Object.freeze({
  start: '2026-07-14T10:00:00.000Z',
  end: '2026-07-14T16:00:00.000Z',
});

function collectorPath(argv) {
  const flagIndex = argv.indexOf('--collector');
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : null;
  const value = fromFlag || process.env.TELEMETRY_DIET_OTELCOL;
  if (!value) {
    throw new Error('Pass --collector /path/to/otelcol-contrib or set TELEMETRY_DIET_OTELCOL.');
  }
  return resolve(value);
}

function completeLogConfig(fragment) {
  const processorLine = /^ {6}processors: .*$/m;
  if (!processorLine.test(fragment)) throw new Error('Generated log draft has no processor pipeline.');
  const pipeline = fragment.replace(processorLine, (line) => [
    '      receivers: [nop]',
    line,
    '      exporters: [nop]',
  ].join('\n'));
  return [
    'receivers:',
    '  nop:',
    'exporters:',
    '  nop:',
    pipeline,
    '',
  ].join('\n');
}

function completeTraceConfig(fragment) {
  const processors = [
    ['transform/trace_intelligence', 'transform/trace_intelligence'],
    ['filter/trace_intelligence', 'filter/trace_intelligence'],
    ['probabilistic_sampler/trace_intelligence_residual', 'probabilistic_sampler/trace_intelligence_residual'],
  ].filter(([marker]) => fragment.includes(marker)).map(([, component]) => component);
  if (processors.length === 0) throw new Error('Generated trace draft has no executable processors.');
  return [
    fragment.trimEnd(),
    'receivers:',
    '  nop:',
    'exporters:',
    '  nop:',
    'service:',
    '  pipelines:',
    '    traces:',
    '      receivers: [nop]',
    `      processors: [${processors.join(', ')}]`,
    '      exporters: [nop]',
    '',
  ].join('\n');
}

function validateCollectorConfig(collector, path) {
  const result = spawnSync(collector, ['validate', '--config', path], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Collector rejected ${path}:\n${detail}`);
  }
}

async function validateLast9Draft(draft) {
  const schemaUrl = new URL('../schemas/telemetry-diet.last9-draft.v1.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(draft)) {
    throw new Error(`Last9 draft failed schema validation:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

async function main() {
  const collector = collectorPath(process.argv.slice(2));
  const summary = getScenarioSummary('checkout-api', 'production', TIME_WINDOW);
  const logArtifacts = generateArtifacts(summary, analyzeTelemetry(summary));
  const traceResult = analyzeTraceIntelligence(getSampleTraceIntelligenceInput());
  const traceDraft = traceResult.artifacts.find(({ format }) => format === 'otel-collector-yaml');
  if (!traceDraft) throw new Error('Trace analysis did not produce an OTel Collector draft.');

  await validateLast9Draft(logArtifacts.last9);
  const validationDir = await mkdtemp(join(tmpdir(), 'telemetry-diet-artifacts-'));
  try {
    const logPath = join(validationDir, 'logs.yaml');
    const tracePath = join(validationDir, 'traces.yaml');
    await Promise.all([
      writeFile(logPath, completeLogConfig(logArtifacts.otel), { encoding: 'utf8', mode: 0o600 }),
      writeFile(tracePath, completeTraceConfig(traceDraft.content), { encoding: 'utf8', mode: 0o600 }),
    ]);
    validateCollectorConfig(collector, logPath);
    validateCollectorConfig(collector, tracePath);
  } finally {
    await rm(validationDir, { recursive: true, force: true });
  }

  console.log('Validated Last9 draft schema and generated log/trace configs.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
