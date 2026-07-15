const checkoutSummary = {
  provider: 'sample',
  service: 'checkout-api',
  environment: 'production',
  recordsAnalyzed: 2000,
  fields: [
    { name: 'service', type: 'string', presence: 2000, uniqueCount: 1, uniqueRatio: 0.0005, topValues: [{ value: 'checkout-api', count: 2000 }] },
    { name: 'service.name', type: 'string', presence: 360, uniqueCount: 2, uniqueRatio: 0.006, topValues: [{ value: 'checkout-api-v2', count: 310 }, { value: 'checkout', count: 50 }] },
    { name: 'app', type: 'string', presence: 120, uniqueCount: 1, uniqueRatio: 0.008, topValues: [{ value: 'web-checkout', count: 120 }] },
    { name: 'env', type: 'string', presence: 2000, uniqueCount: 1, uniqueRatio: 0.0005, topValues: [{ value: 'production', count: 2000 }] },
    { name: 'environment', type: 'string', presence: 240, uniqueCount: 1, uniqueRatio: 0.004, topValues: [{ value: 'prod', count: 240 }] },
    { name: 'user.id', type: 'string', presence: 1400, uniqueCount: 1176, uniqueRatio: 0.84, examplesRedacted: ['usr_08f***41', 'usr_7ac***29'] },
    { name: 'session.id', type: 'string', presence: 920, uniqueCount: 911, uniqueRatio: 0.99, examplesRedacted: ['session.id=[REDACTED]', 'session.id=[REDACTED]'], risks: ['likely-token'] },
    { name: 'request.id', type: 'string', presence: 2000, uniqueCount: 2000, uniqueRatio: 1, examplesRedacted: ['request.id=[REDACTED]', 'request.id=[REDACTED]'] },
    { name: 'user.email', type: 'string', presence: 310, uniqueCount: 276, uniqueRatio: 0.89, examplesRedacted: ['a***@example.com', 'o***@mail.test'], risks: ['likely-email'] },
    { name: 'http.request.header.authorization', type: 'string', presence: 54, uniqueCount: 52, uniqueRatio: 0.963, examplesRedacted: ['Bearer [REDACTED]'], risks: ['likely-secret'] },
    { name: 'cart.item_count', type: 'integer', presence: 870, uniqueCount: 12, uniqueRatio: 0.014, topValues: [{ value: '1', count: 291 }, { value: '2', count: 178 }] },
  ],
  messages: [
    { fingerprint: 'kube-probe request completed status=?', count: 340, severity: 'INFO', examplesRedacted: ['GET /healthz 200 duration=2ms'] },
    { fingerprint: 'ready probe completed status=?', count: 80, severity: 'INFO', examplesRedacted: ['GET /ready 200 duration=1ms'] },
    { fingerprint: 'prometheus scrape completed status=?', count: 80, severity: 'INFO', examplesRedacted: ['GET /metrics 200 duration=7ms'] },
    { fingerprint: 'cart price calculation details', count: 260, severity: 'DEBUG', examplesRedacted: ['calculated cart subtotal user=usr_*** items=2'] },
    { fingerprint: 'checkout completed order=?', count: 188, severity: 'INFO', examplesRedacted: ['checkout completed order=ord_*** status=accepted'] },
    { fingerprint: 'payment authorization failed reason=?', count: 18, severity: 'ERROR', examplesRedacted: ['payment authorization failed reason=issuer_declined'] },
  ],
  endpoints: [
    { path: '/healthz', count: 340, statusClass: '2xx', method: 'GET' },
    { path: '/ready', count: 80, statusClass: '2xx', method: 'GET' },
    { path: '/metrics', count: 80, statusClass: '2xx', method: 'GET' },
    { path: '/checkout', count: 671, statusClass: '2xx', method: 'POST' },
    { path: '/checkout', count: 23, statusClass: '5xx', method: 'POST' },
  ],
  existingPolicies: [
    { provider: 'sample', name: 'retain-errors', type: 'retention', summary: 'Retain ERROR and FATAL records without sampling.' },
  ],
};

const paymentSummary = {
  provider: 'sample',
  service: 'payment-worker',
  environment: 'production',
  recordsAnalyzed: 1240,
  fields: [
    { name: 'service.name', type: 'string', presence: 1240, uniqueCount: 1, uniqueRatio: 0.001, topValues: [{ value: 'payment-worker', count: 1240 }] },
    { name: 'deployment.environment.name', type: 'string', presence: 1240, uniqueCount: 1, uniqueRatio: 0.001, topValues: [{ value: 'production', count: 1240 }] },
    { name: 'payment.intent_id', type: 'string', presence: 940, uniqueCount: 931, uniqueRatio: 0.99, examplesRedacted: ['pi_3N***', 'pi_8K***'] },
    { name: 'request.id', type: 'string', presence: 1240, uniqueCount: 1240, uniqueRatio: 1, examplesRedacted: ['request.id=[REDACTED]'] },
    { name: 'customer.email', type: 'string', presence: 82, uniqueCount: 79, uniqueRatio: 0.963, examplesRedacted: ['j***@example.com'], risks: ['likely-email'] },
  ],
  messages: [
    { fingerprint: 'queue heartbeat partition=?', count: 260, severity: 'DEBUG', examplesRedacted: ['queue heartbeat partition=3 lag=0'] },
    { fingerprint: 'payment intent processed status=?', count: 714, severity: 'INFO', examplesRedacted: ['payment intent pi_*** processed status=succeeded'] },
  ],
  endpoints: [{ path: '/health', count: 130, statusClass: '2xx', method: 'GET' }],
  existingPolicies: [],
};

const scenarios = {
  'checkout-api': {
    environments: ['production', 'staging'],
    summary: checkoutSummary,
    samples: [
      { timestamp: '2026-07-14T17:01:00Z', severity: 'INFO', message: 'GET /healthz 200 duration=2ms', attributes: { service: 'checkout-api', env: 'production', 'request.id': '[REDACTED]' } },
      { timestamp: '2026-07-14T17:01:03Z', severity: 'DEBUG', message: 'calculated cart subtotal user=usr_*** items=2', attributes: { service: 'checkout-api', env: 'production', 'user.email': 'a***@example.com' } },
      { timestamp: '2026-07-14T17:01:08Z', severity: 'ERROR', message: 'payment authorization failed reason=issuer_declined', attributes: { service: 'checkout-api', env: 'production' } },
    ],
  },
  'payment-worker': {
    environments: ['production', 'staging'],
    summary: paymentSummary,
    samples: [
      { timestamp: '2026-07-14T17:02:00Z', severity: 'DEBUG', message: 'queue heartbeat partition=3 lag=0', attributes: { 'service.name': 'payment-worker', 'deployment.environment.name': 'production' } },
      { timestamp: '2026-07-14T17:02:06Z', severity: 'INFO', message: 'payment intent pi_*** processed status=succeeded', attributes: { 'service.name': 'payment-worker', 'payment.intent_id': 'pi_***' } },
    ],
  },
};

export function listServices() {
  return Object.entries(scenarios).map(([name, scenario]) => ({ name, environments: scenario.environments }));
}

export function getEnvironments(service) {
  return scenarios[service]?.environments || [];
}

export function getScenarioSummary(service, environment, timeWindow) {
  const scenario = scenarios[service];
  if (!scenario) throw new Error(`Unknown sample service: ${service}`);
  return {
    ...structuredClone(scenario.summary),
    environment: environment || scenario.summary.environment,
    timeWindow,
  };
}

export function getRedactedSamples(service, limit = 3) {
  return (scenarios[service]?.samples || []).slice(0, Math.min(limit, 10));
}
