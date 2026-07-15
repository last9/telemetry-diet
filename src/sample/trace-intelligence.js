export function getSampleTraceIntelligenceInput() {
  return {
    aggregates: [
      {
        spanKind: 'SERVER',
        spanName: 'POST /checkout',
        instrumentationScope: 'http.server',
        resourceAttributes: [
          { key: 'service.name', bytes: 1_200, safeToTrim: false },
          { key: 'process.command_line', bytes: 7_600, safeToTrim: true },
        ],
        bytes: 18_000,
        count: 100,
        errorCount: 4,
      },
      {
        spanKind: 'INTERNAL',
        spanName: 'Order query wrapper',
        instrumentationScope: 'orm.repository',
        redundantWith: 'db.client',
        resourceAttributes: [
          { key: 'service.name', bytes: 900, safeToTrim: false },
          { key: 'process.command_line', bytes: 5_400, safeToTrim: true },
        ],
        bytes: 12_000,
        count: 80,
        errorCount: 0,
      },
      {
        spanKind: 'CLIENT',
        spanName: 'SELECT orders',
        instrumentationScope: 'db.client',
        resourceAttributes: [
          { key: 'service.name', bytes: 900, safeToTrim: false },
          { key: 'process.command_line', bytes: 5_400, safeToTrim: true },
        ],
        bytes: 14_000,
        count: 80,
        errorCount: 0,
      },
      {
        spanKind: 'INTERNAL',
        spanName: 'cache ping',
        instrumentationScope: 'cache.client',
        resourceAttributes: [{ key: 'service.name', bytes: 300, safeToTrim: false }],
        bytes: 2_400,
        count: 40,
        errorCount: 0,
        leaf: true,
        lowValue: true,
      },
      {
        spanKind: 'INTERNAL',
        spanName: 'calculate cart total',
        instrumentationScope: 'application',
        resourceAttributes: [{ key: 'service.name', bytes: 160, safeToTrim: false }],
        bytes: 1_800,
        count: 20,
        errorCount: 1,
        businessSpan: true,
      },
    ],
    residualHeadSampling: { ratio: 0.5 },
  };
}
