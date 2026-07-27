import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeScrapeVolume } from '../src/metric-usage/index.js';

test('ranks jobs by samples per scrape and joins target counts where known', () => {
  const result = analyzeScrapeVolume({
    targetsByJob: [
      { job: 'dynamo-svc', targetCount: 60 },
      { job: 'api-svc', targetCount: 17 },
    ],
    samplesByJob: [
      { job: 'api-svc', samples: 151284 },
      { job: 'dynamo-svc', samples: 213882 },
      { job: 'elastit-svc', samples: 69029 },
    ],
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.topJobs, [
    { job: 'dynamo-svc', samplesPerScrape: 213882, targetCount: 60 },
    { job: 'api-svc', samplesPerScrape: 151284, targetCount: 17 },
    { job: 'elastit-svc', samplesPerScrape: 69029, targetCount: null },
  ]);
  assert.equal(result.limitations.length, 1);
  assert.match(result.limitations[0], /do not measure scrape frequency/i);
});

test('caps ranked jobs at the top-8 limit', () => {
  const samplesByJob = Array.from({ length: 12 }, (_, index) => ({ job: `job-${index}`, samples: 100 - index }));
  const result = analyzeScrapeVolume({ targetsByJob: [], samplesByJob });

  assert.equal(result.topJobs.length, 8);
  assert.equal(result.topJobs[0].job, 'job-0');
});

test('is unavailable when scrape volume is absent, empty, or malformed', () => {
  assert.deepEqual(analyzeScrapeVolume(null), { available: false, topJobs: [], limitations: [] });
  assert.deepEqual(analyzeScrapeVolume(undefined), { available: false, topJobs: [], limitations: [] });
  assert.deepEqual(
    analyzeScrapeVolume({ targetsByJob: [], samplesByJob: [] }),
    { available: false, topJobs: [], limitations: [] },
  );
  assert.deepEqual(
    analyzeScrapeVolume({ targetsByJob: [], samplesByJob: [{ job: 'x', samples: Number.NaN }] }),
    { available: false, topJobs: [], limitations: [] },
  );
});

test('rejects a scrape volume object with non-array fields', () => {
  assert.throws(() => analyzeScrapeVolume({ targetsByJob: [], samplesByJob: 'not-an-array' }), TypeError);
  assert.throws(() => analyzeScrapeVolume({ targetsByJob: 'not-an-array', samplesByJob: [] }), TypeError);
});
