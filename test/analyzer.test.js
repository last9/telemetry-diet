import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTelemetry, generateArtifacts, redact } from '../src/core/index.js';
import { getScenarioSummary } from '../src/sample/scenarios.js';

const timeWindow = { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' };

test('sample analysis is deterministic and produces expected findings', () => {
  const summary = getScenarioSummary('checkout-api', 'production', timeWindow);
  const first = analyzeTelemetry(summary);
  const second = analyzeTelemetry(summary);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 5);
  assert.ok(first.some(({ id }) => id === 'noise.health-success'));
  assert.ok(first.some(({ id }) => id === 'noise.debug'));
  assert.ok(first.some(({ id }) => id === 'risk.likely-email.user.email'));
  assert.ok(first.some(({ id }) => id === 'cardinality.user.id'));
  assert.ok(first.some(({ id }) => id === 'drift.resource-naming'));
});

test('default policy preview preserves the 38 percent sample impact', () => {
  const summary = getScenarioSummary('checkout-api', 'production', timeWindow);
  const findings = analyzeTelemetry(summary);
  const artifacts = generateArtifacts(summary, findings);
  assert.equal(artifacts.preview.recordsAnalyzed, 2000);
  assert.equal(artifacts.preview.recordsAffected, 760);
  assert.equal(artifacts.preview.recordsAfter, 1240);
  assert.equal(artifacts.preview.directionalReductionPercent, 38);
  assert.deepEqual(artifacts.preview.redactedFields.sort(), ['http.request.header.authorization', 'session.id', 'user.email']);
});

test('generated artifacts are visible drafts with safety markers', () => {
  const summary = {
    ...getScenarioSummary('checkout-api', 'production', timeWindow),
    limitations: ['Provider returned a partial aggregate; manual review is required.'],
  };
  const findings = analyzeTelemetry(summary);
  const artifacts = generateArtifacts(summary, findings);
  assert.match(artifacts.otel, /filter\/telemetry_diet/);
  assert.match(artifacts.otel, /delete_key\(attributes/);
  assert.match(artifacts.otel, /severity_number >= SEVERITY_NUMBER_TRACE and severity_number < SEVERITY_NUMBER_INFO/);
  assert.equal(artifacts.last9.draft, true);
  assert.equal(artifacts.last9.apply, false);
  const healthRule = artifacts.last9.rules.find(({ sourceFinding }) => sourceFinding.findingId === 'noise.health-success');
  assert.deepEqual(healthRule.filters.all.slice(1), [
    { field: 'http.response.status_code', operator: 'gte', value: 200 },
    { field: 'http.response.status_code', operator: 'lt', value: 300 },
  ]);
  assert.match(artifacts.markdown, /Evidence first\. Human reviewed\. You apply\./);
  assert.match(artifacts.markdown, /Telemetry Diet does not call an AI service/);
  assert.match(artifacts.markdown, /Provider limitation: Provider returned a partial aggregate/);
});

test('redaction removes emails, bearer values, tokens, and request identifiers', () => {
  const input = 'email alex@example.com Authorization: Bearer abc.def.ghi request.id=req_1234567890 token_live_abcdefghijkl password=hunter2';
  const output = redact(input);
  assert.doesNotMatch(output, /alex@example\.com/);
  assert.doesNotMatch(output, /abc\.def\.ghi/);
  assert.doesNotMatch(output, /req_1234567890/);
  assert.doesNotMatch(output, /abcdefghijkl/);
  assert.doesNotMatch(output, /hunter2/);
  assert.match(output, /REDACTED/);
});
