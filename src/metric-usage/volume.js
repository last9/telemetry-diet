const TOP_JOB_LIMIT = 8;
const SCRAPE_INTERVAL_LIMITATION =
  'Scrape interval is a ServiceMonitor/PodMonitor config value and is not visible from ingested metrics; confirm actual intervals before assuming savings.';

function validateScrapeVolume(scrapeVolume) {
  if (scrapeVolume == null) return;
  if (typeof scrapeVolume !== 'object') {
    throw new TypeError('Metric usage scrape volume must be an object.');
  }
  for (const field of ['targetsByJob', 'samplesByJob']) {
    if (!Array.isArray(scrapeVolume[field])) {
      throw new TypeError(`Metric usage scrape volume ${field} must be an array.`);
    }
  }
}

function unavailable() {
  return { available: false, topJobs: [], limitations: [] };
}

// Ranks jobs by samples scraped per cycle (`scrape_samples_scraped`, summed by job) and
// joins in target counts (`up`, summed by job) where known. Scrape interval is a direct
// multiplier on ingestion volume, so this surfaces which ServiceMonitors/PodMonitors are
// worth reviewing — it never claims an exact samples/sec or byte savings figure, since
// the interval itself isn't visible from ingested metrics.
export function analyzeScrapeVolume(scrapeVolume) {
  validateScrapeVolume(scrapeVolume);
  if (!scrapeVolume) return unavailable();

  const targetCountByJob = new Map(
    scrapeVolume.targetsByJob
      .filter((entry) => entry && typeof entry.job === 'string')
      .map((entry) => [entry.job, entry.targetCount]),
  );

  const topJobs = scrapeVolume.samplesByJob
    .filter((entry) => entry && typeof entry.job === 'string' && Number.isFinite(entry.samples))
    .sort((left, right) => right.samples - left.samples)
    .slice(0, TOP_JOB_LIMIT)
    .map(({ job, samples }) => ({
      job,
      samplesPerScrape: samples,
      targetCount: targetCountByJob.has(job) ? targetCountByJob.get(job) : null,
    }));

  if (!topJobs.length) return unavailable();

  return {
    available: true,
    topJobs,
    limitations: [SCRAPE_INTERVAL_LIMITATION],
  };
}
