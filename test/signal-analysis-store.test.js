import assert from 'node:assert/strict';
import test from 'node:test';

import { createSignalAnalysisStore } from '../src/signals/analysis.js';

const validateTimeWindow = (value) => value;

test('signal store rejects providers outside sample and Last9 before collection', async () => {
  const store = createSignalAnalysisStore({ env: {}, oauth: undefined });
  for (const provider of [undefined, 'unknown', 'datadog']) {
    await assert.rejects(
      store.analyze({ provider, signal: 'metrics' }, validateTimeWindow),
      /sample provider or Last9 MCP/i,
    );
    await assert.rejects(
      store.analyze({
        provider,
        signal: 'traces',
        service: 'checkout-api',
        timeWindow: { start: 'start', end: 'end' },
      }, validateTimeWindow),
      /sample provider or Last9 MCP/i,
    );
  }
});

test('trace signal store returns separate Collector and OTTL drafts', async () => {
  const store = createSignalAnalysisStore({ env: {}, oauth: undefined });
  const analysis = await store.analyze({
    provider: 'sample',
    signal: 'traces',
    service: 'checkout-api',
    timeWindow: { start: 'start', end: 'end' },
  }, validateTimeWindow);

  assert.match(analysis.artifacts.collector, /EXPORT-ONLY DRAFT/);
  assert.match(analysis.artifacts.ottl, /EXPORT-ONLY DRAFT/);
  assert.equal('otel' in analysis.artifacts, false);
  assert.deepEqual(store.get(analysis.analysisId), analysis);
});
