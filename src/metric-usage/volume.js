const TOP_JOB_LIMIT = 8;
const SCRAPE_VOLUME_LIMITATION =
  'Samples per scrape do not measure scrape frequency, and observed target counts do not prove duplicate collection; inspect collection configuration before assuming savings.';

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
// joins in observed target counts (`up`, counted by job) where known. This surfaces
// which ServiceMonitors/PodMonitors are worth reviewing without claiming to measure
// scrape frequency, prove duplicate collection, or estimate exact savings.
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
    limitations: [SCRAPE_VOLUME_LIMITATION],
  };
}
