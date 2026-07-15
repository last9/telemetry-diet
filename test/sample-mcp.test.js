import assert from 'node:assert/strict';
import test from 'node:test';
import { SampleAdapter } from '../src/providers/sample.js';

test('sample adapter discovers scopes and analyzes over bundled MCP', async (t) => {
  const adapter = new SampleAdapter();
  t.after(() => adapter.close());
  const connection = await adapter.connect();
  assert.equal(connection.readOnly, true);
  assert.equal(connection.serverInfo.name, 'telemetry-diet-sample');
  assert.deepEqual(await adapter.discoverServices(), ['checkout-api', 'payment-worker']);
  assert.deepEqual(await adapter.getEnvironments('checkout-api'), ['production', 'staging']);
  const summary = await adapter.analyze({
    service: 'checkout-api',
    environment: 'production',
    timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
  });
  assert.equal(summary.recordsAnalyzed, 2000);
  assert.ok(summary.fields.length > 5);
  assert.ok(summary.messages.length > 3);
});
