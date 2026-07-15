import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeTraceIntelligence } from '../src/trace-intelligence/index.js';
import { renderTraceIntelligenceMarkdown } from '../src/trace-intelligence/artifacts.js';

test('analysis exports visible non-applying OTel and OTTL drafts with safety limitations', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      {
        spanKind: 'INTERNAL', spanName: 'encode payload', instrumentationScope: 'payload.encoder',
        bytes: 900, count: 300, errorCount: 0, leaf: true, lowValue: true,
        resourceAttributes: [{ key: 'process.command_args', bytes: 450, safeToTrim: true }],
      },
      {
        spanKind: 'INTERNAL', spanName: 'validate order', instrumentationScope: 'domain.rules',
        bytes: 1_800, count: 300, errorCount: 0, leaf: true, lowValue: true, businessSpan: true,
      },
      {
        spanKind: 'INTERNAL', spanName: 'cache lookup', instrumentationScope: 'cache.client',
        bytes: 1_500, count: 300, errorCount: 3, leaf: true, lowValue: true,
      },
    ],
    residualHeadSampling: { ratio: 0.25 },
  });

  assert.equal(result.artifacts.length, 2);
  assert.ok(result.artifacts.every(({ apply, label }) => apply === false && /EXPORT-ONLY DRAFT/.test(label)));
  assert.match(result.artifacts[0].content, /transform\/trace_intelligence/);
  assert.match(result.artifacts[0].content, /sampling_percentage: 25/);
  assert.match(result.artifacts[1].content, /delete_key\(resource\.attributes, "process\.command_args"\)/);
  assert.match(result.artifacts[1].content, /name == "encode payload"/);
  assert.doesNotMatch(result.artifacts[1].content, /^drop\(\) where kind == SPAN_KIND_INTERNAL$/m);
  assert.match(result.limitations.join('\n'), /SDK and instrumentation-library specific/);
  assert.match(result.limitations.join('\n'), /error and business-span coverage/);
  assert.match(result.limitations.join('\n'), /compression and exporter overhead/);
  assert.match(result.limitations.join('\n'), /APM visibility/);
});

test('markdown distinguishes observed bytes from an unavailable complete total', () => {
  const result = analyzeTraceIntelligence({
    aggregates: [
      { spanKind: 'SERVER', spanName: 'GET /orders', bytes: 500, count: 10 },
      { spanKind: 'INTERNAL', spanName: 'encode response', count: 10 },
    ],
  });

  const markdown = renderTraceIntelligenceMarkdown(result);
  assert.match(markdown, /Measured bytes observed: 500/);
  assert.match(markdown, /Complete byte total: unavailable/);
  assert.match(markdown, /Byte measurements: 1 measured; 1 unmeasured/);
});
