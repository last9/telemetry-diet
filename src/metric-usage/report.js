function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('\n', ' ')
    .replaceAll('|', '\\|');
}

export function renderMetricUsageJson(report, { metrics = report.metrics } = {}) {
  return JSON.stringify({ ...report, metrics }, null, 2);
}

export function renderMetricUsageMarkdown(report, { metrics = report.metrics } = {}) {
  const { summary } = report;
  const lines = [
    '# Metric usage report',
    '',
    '> Unreferenced means unreferenced in scanned sources only. Protection policy is reported separately.',
    '',
    '## Summary',
    '',
    '| Measure | Count |',
    '| --- | ---: |',
    `| Metrics in result | ${summary.metricCount} |`,
    `| Metrics in catalog | ${summary.catalogCount} |`,
    `| Referenced by two or more queries | ${summary.referencedCount} |`,
    `| Referenced by one query | ${summary.underreferencedCount} |`,
    `| Unreferenced in scanned sources | ${summary.unreferencedCount} |`,
    `| Protected by policy | ${summary.protectedCount} |`,
    '',
    '## Limitations',
    '',
    ...(report.limitations.length
      ? report.limitations.map((limitation) => `- ${limitation}`)
      : ['- No collection or parsing limitations were reported.']),
    '',
    '## Metrics',
    '',
    '| Metric | Status | Protected | In catalog | References |',
    '| --- | --- | --- | --- | ---: |',
    ...metrics.map((metric) => `| \`${markdownCell(metric.name)}\` | ${metric.status} | ${metric.protected ? 'yes' : 'no'} | ${metric.inCatalog ? 'yes' : 'no'} | ${metric.referenceCount} |`),
  ];

  const locatedMetrics = metrics.filter(({ locations }) => locations.length);
  if (locatedMetrics.length) {
    lines.push('', '## Reference locations', '');
    for (const metric of locatedMetrics) {
      lines.push(`### \`${markdownCell(metric.name)}\``, '');
      lines.push('| Kind | Source | Source ID | Updated | Query |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const location of metric.locations) {
        lines.push(`| ${markdownCell(location.kind)} | ${markdownCell(location.sourceName)} | ${markdownCell(location.sourceId)} | ${markdownCell(location.updatedAt || '')} | \`${markdownCell(location.query)}\` |`);
      }
      lines.push('');
    }
  }

  if (report.unparsedQueries.length) {
    lines.push('## Unparsed PromQL', '');
    for (const query of report.unparsedQueries) {
      lines.push('```promql', query, '```', '');
    }
  }

  if (report.scrapeVolume?.available) {
    lines.push(
      '## Scrape-volume configuration review',
      '',
      'The jobs below account for the largest current sample volume per scrape. Use them '
        + 'as starting points to inspect ServiceMonitor/PodMonitor `scrape_interval`, '
        + 'unexpected target fan-out, and redundant collection configuration.',
      '',
      '| Job | Samples per scrape | Observed targets |',
      '| --- | ---: | ---: |',
      ...report.scrapeVolume.topJobs.map(({ job, samplesPerScrape, targetCount }) =>
        `| \`${markdownCell(job)}\` | ${Math.round(samplesPerScrape)} | ${targetCount ?? '—'} |`),
      '',
      ...report.scrapeVolume.limitations.map((limitation) => `> ${limitation}`),
      '',
    );
  }

  return lines.join('\n').trimEnd();
}
