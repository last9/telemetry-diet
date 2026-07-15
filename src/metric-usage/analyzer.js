import { extractMetricNames, PromQlParseError } from './promql.js';
import { createProtectionPolicy } from './whitelist.js';

function unique(values) {
  return [...new Set(values)];
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('Metric usage snapshot must be an object.');
  }
  for (const field of ['metricNames', 'references', 'warnings']) {
    if (!Array.isArray(snapshot[field])) {
      throw new TypeError(`Metric usage snapshot ${field} must be an array.`);
    }
  }
}

function validateReference(reference) {
  if (!reference || typeof reference !== 'object') {
    throw new TypeError('Metric usage references must be objects.');
  }
  for (const field of ['kind', 'sourceId', 'sourceName', 'query']) {
    if (typeof reference[field] !== 'string') {
      throw new TypeError(`Metric usage reference ${field} must be a string.`);
    }
  }
}

function locationFrom(reference) {
  return {
    kind: reference.kind,
    sourceId: reference.sourceId,
    sourceName: reference.sourceName,
    query: reference.query,
    updatedAt: reference.updatedAt ?? null,
  };
}

function observedStatus(referenceCount) {
  if (referenceCount === 0) return 'unreferenced';
  if (referenceCount === 1) return 'underreferenced';
  return 'referenced';
}

export function analyzeMetricUsage(snapshot, options = {}) {
  validateSnapshot(snapshot);
  const catalog = new Set(snapshot.metricNames);
  const protection = createProtectionPolicy(options.protection);
  const locationsByMetric = new Map([...catalog].map((name) => [name, []]));
  const unparsedQueries = [];
  const parseLimitations = [];
  let hasGenericParseFailure = false;
  const metricsByQuery = new Map();

  for (const reference of snapshot.references) {
    validateReference(reference);
    if (!metricsByQuery.has(reference.query)) {
      try {
        metricsByQuery.set(reference.query, extractMetricNames(reference.query));
      } catch (error) {
        if (!(error instanceof PromQlParseError)) throw error;
        metricsByQuery.set(reference.query, null);
        if (error.limitation) parseLimitations.push(error.limitation);
        else hasGenericParseFailure = true;
      }
    }
    const metricNames = metricsByQuery.get(reference.query);
    if (metricNames === null) {
      unparsedQueries.push(reference.query);
      continue;
    }

    for (const metricName of metricNames) {
      if (!locationsByMetric.has(metricName)) locationsByMetric.set(metricName, []);
      locationsByMetric.get(metricName).push(locationFrom(reference));
    }
  }

  const metrics = [...locationsByMetric]
    .map(([name, locations]) => ({
      name,
      inCatalog: catalog.has(name),
      status: observedStatus(locations.length),
      protected: protection.protects(name),
      referenceCount: locations.length,
      locations,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    summary: {
      metricCount: metrics.length,
      catalogCount: catalog.size,
      referencedCount: metrics.filter(({ status }) => status === 'referenced').length,
      underreferencedCount: metrics.filter(({ status }) => status === 'underreferenced').length,
      unreferencedCount: metrics.filter(({ status }) => status === 'unreferenced').length,
      protectedCount: metrics.filter((metric) => metric.protected).length,
    },
    metrics,
    warnings: unique(snapshot.warnings),
    unparsedQueries: unique(unparsedQueries),
    limitations: unique([
      ...snapshot.warnings,
      ...parseLimitations,
      ...(hasGenericParseFailure ? ['Some PromQL queries could not be parsed; reference counts may be incomplete.'] : []),
    ]),
  };
}
