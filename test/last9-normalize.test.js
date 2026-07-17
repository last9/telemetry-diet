import assert from 'node:assert/strict';
import test from 'node:test';
import {
  environmentsFromLast9,
  normalizeLast9Logs,
  policiesFromLast9,
  servicesFromLast9Summary,
} from '../src/providers/last9-normalize.js';

const context = {
  provider: 'last9', service: 'checkout', environment: 'production',
  timeWindow: { start: '2026-07-14T10:00:00.000Z', end: '2026-07-14T16:00:00.000Z' },
};

test('Last9 service and environment contracts normalize independently', () => {
  assert.deepEqual(servicesFromLast9Summary({
    checkout: { ServiceName: 'checkout', Throughput: 42 },
    payment: { ServiceName: 'payment', Throughput: 17 },
  }), ['checkout', 'payment']);
  assert.deepEqual(environmentsFromLast9(['production', 'alpha', 'production']), ['alpha', 'production']);
});

test('Last9 log response preserves provider totals and discards raw records', () => {
  const summary = normalizeLast9Logs({
    service: 'checkout', count: 25,
    logs: [{ timestamp: '2026-07-14T12:00:00Z', message: 'checkout completed', severity: 'INFO', service_name: 'checkout' }],
  }, context);
  assert.equal(summary.recordsAnalyzed, 25);
  assert.equal(summary.messages[0].fingerprint, 'checkout completed');
  assert.equal(Object.hasOwn(summary, 'logs'), false);
});

test('Last9 empty log collections and existing policies remain valid context', () => {
  const policies = policiesFromLast9({ rules: [{ name: 'drop-health', filters: [{ key: 'path', value: '/healthz' }] }] });
  const summary = normalizeLast9Logs({ service: 'checkout', count: 0, logs: [] }, context, { existingPolicies: policies });
  assert.equal(summary.recordsAnalyzed, 0);
  assert.equal(summary.existingPolicies[0].name, 'drop-health');
});

test('Last9 normalization rejects a raw-record response above the advertised limit', () => {
  assert.throws(
    () => normalizeLast9Logs({ count: 2, logs: [{ message: 'one' }, { message: 'two' }] }, context, { limit: 1 }),
    /exceeded the advertised safe result limit/i,
  );
});
