import { randomUUID } from 'node:crypto';

import { analyzeMetricUsage, renderMetricUsageMarkdown } from '../metric-usage/index.js';
import { Last9MetricsAdapter } from '../providers/last9-metrics.js';
import { Last9TracesAdapter } from '../providers/last9-traces.js';
import { getSampleMetricUsageSnapshot } from '../sample/metric-usage.js';
import { getSampleTraceIntelligenceInput } from '../sample/trace-intelligence.js';
import { renderTraceIntelligenceMarkdown } from '../trace-intelligence/artifacts.js';
import { analyzeTraceIntelligence } from '../trace-intelligence/index.js';

function validateProvider(provider, label) {
  if (!['sample', 'last9'].includes(provider)) {
    throw new Error(`${label} currently requires the sample provider or Last9 MCP.`);
  }
}

function contentByFormat(artifacts, format) {
  return artifacts.find((artifact) => artifact.format === format)?.content || '';
}

export function createSignalAnalysisStore({ env, oauth }) {
  const analyses = new Map();

  function retain(analysis) {
    analyses.set(analysis.analysisId, analysis);
    if (analyses.size > 20) analyses.delete(analyses.keys().next().value);
    return analysis;
  }

  async function collectWith(Adapter, collect) {
    const adapter = new Adapter(env, { oauth });
    try {
      await adapter.connect();
      return await collect(adapter);
    } finally {
      await adapter.close();
    }
  }

  async function analyzeMetrics(input) {
    validateProvider(input.provider, 'Metric usage');
    const snapshot = input.provider === 'sample'
      ? getSampleMetricUsageSnapshot()
      : await collectWith(Last9MetricsAdapter, (adapter) => adapter.collect());
    const result = analyzeMetricUsage(snapshot);
    return retain({
      analysisId: randomUUID(),
      analysisType: 'metrics',
      result,
      artifacts: { markdown: renderMetricUsageMarkdown(result), json: result },
    });
  }

  async function analyzeTraces(input, validateTimeWindow) {
    validateProvider(input.provider, 'Trace intelligence');
    if (!input.service) throw new Error('Choose a service.');
    const timeWindow = validateTimeWindow(input.timeWindow);
    const traceInput = input.provider === 'sample'
      ? getSampleTraceIntelligenceInput()
      : await collectWith(Last9TracesAdapter, (adapter) => adapter.collect({
        service: input.service,
        environment: input.environment,
        timeWindow,
      }));
    const result = analyzeTraceIntelligence(traceInput);
    return retain({
      analysisId: randomUUID(),
      analysisType: 'traces',
      result,
      artifacts: {
        collector: contentByFormat(result.artifacts, 'otel-collector-yaml'),
        ottl: contentByFormat(result.artifacts, 'ottl'),
        markdown: renderTraceIntelligenceMarkdown(result),
      },
    });
  }

  return {
    get: (analysisId) => analyses.get(analysisId),
    async analyze(input, validateTimeWindow) {
      if (input.signal === 'metrics') return analyzeMetrics(input);
      if (input.signal === 'traces') return analyzeTraces(input, validateTimeWindow);
      return null;
    },
  };
}
