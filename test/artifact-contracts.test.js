import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { analyzeTelemetry } from '../src/core/analyzer.js';
import { generateArtifacts } from '../src/core/report.js';
import { getScenarioSummary } from '../src/sample/scenarios.js';

const timeWindow = { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' };

async function last9Validator() {
  const schemaUrl = new URL('../schemas/telemetry-diet.last9-draft.v1.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

test('generated Last9 policy conforms to the published non-applying v1 schema', async () => {
  const summary = getScenarioSummary('checkout-api', 'production', timeWindow);
  const artifact = generateArtifacts(summary, analyzeTelemetry(summary)).last9;
  const validate = await last9Validator();

  assert.equal(validate(artifact), true, JSON.stringify(validate.errors));
  assert.equal(artifact.draft, true);
  assert.equal(artifact.apply, false);
});

test('Last9 schema rejects an artifact that claims it can apply changes', async () => {
  const summary = getScenarioSummary('checkout-api', 'production', timeWindow);
  const artifact = generateArtifacts(summary, analyzeTelemetry(summary)).last9;
  const validate = await last9Validator();

  assert.equal(validate({ ...artifact, apply: true }), false);
  assert.ok(validate.errors.some(({ instancePath }) => instancePath === '/apply'));
});

test('Last9 artifact scope contains only the published fields', async () => {
  const summary = {
    ...getScenarioSummary('checkout-api', 'production', timeWindow),
    timeWindow: { ...timeWindow, upstreamInternal: 'discard me' },
  };
  const artifact = generateArtifacts(summary, analyzeTelemetry(summary)).last9;
  const validate = await last9Validator();

  assert.deepEqual(Object.keys(artifact.scope.timeWindow).sort(), ['end', 'start']);
  assert.equal(validate(artifact), true, JSON.stringify(validate.errors));
});
