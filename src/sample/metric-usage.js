export function getSampleMetricUsageSnapshot() {
  return {
    metricNames: [
      'checkout_requests_total',
      'checkout_duration_seconds_bucket',
      'worker_jobs_total',
      'legacy_metric_total',
      'kube_pod_info',
    ],
    references: [
      {
        kind: 'dashboard',
        sourceId: 'dashboard-overview',
        sourceName: 'Service overview > Request rate',
        query: 'sum(rate(checkout_requests_total[5m]))',
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        kind: 'dashboard',
        sourceId: 'dashboard-overview',
        sourceName: 'Service overview > Latency',
        query: 'histogram_quantile(0.95, sum by (le) (rate(checkout_duration_seconds_bucket[5m])))',
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
      {
        kind: 'alert',
        sourceId: 'alert-throughput',
        sourceName: 'Request throughput',
        query: 'sum(rate(checkout_requests_total[10m])) < 1',
        updatedAt: '2026-07-14T13:00:00.000Z',
      },
      {
        kind: 'indicator',
        sourceId: 'indicator-jobs',
        sourceName: 'Worker jobs processed',
        query: 'sum(increase(worker_jobs_total[1h]))',
        updatedAt: '2026-07-14T14:00:00.000Z',
      },
    ],
    warnings: [
      'Unreferenced means unreferenced in scanned dashboards, alerts, and indicators; ad hoc queries and external consumers are not observed.',
    ],
    scrapeVolume: {
      targetsByJob: [
        { job: 'checkout-api', targetCount: 30 },
        { job: 'worker-svc', targetCount: 12 },
        { job: 'istio-proxy', targetCount: 42 },
      ],
      samplesByJob: [
        { job: 'checkout-api', samples: 151284 },
        { job: 'istio-proxy', samples: 105510 },
        { job: 'worker-svc', samples: 41230 },
      ],
    },
  };
}
