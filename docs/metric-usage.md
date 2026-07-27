# Metric usage

Metric usage answers a narrow question: which catalog metrics are referenced by the query definitions Telemetry Diet was able to scan?

## Inputs

The read-only adapter collects a metric-name inventory and PromQL from available native dashboards, embedded Grafana dashboards, alert definitions, and entity indicators. Every reference retains its source type, ID, display path, query, and update timestamp when available.

PromQL is parsed with a syntax tree. Metric selectors inside functions, aggregations, binary expressions, subqueries, offsets, and label matchers are discovered without treating function or label names as metrics. Queries that cannot be parsed are reported as limitations instead of being silently ignored.

## Status model

- **Referenced**: present in two or more scanned references.
- **Underreferenced**: present in exactly one scanned reference.
- **Unreferenced**: absent from the scanned references.

A protected metric prefix is reported separately. Protection does not change usage status.

## Interpretation boundary

“Unreferenced” means unreferenced in scanned sources only. Ad hoc queries, recording rules outside the exposed definitions, API clients, external dashboards, and other consumers may not be visible. Review provenance and validate with owners before changing collection.

The workflow exports Markdown and JSON. It has no delete, disable, or write path.

## Scrape-volume configuration review — optional

When the Last9 MCP server advertises a PromQL instant-query capability (e.g. `prometheus_instant_query`), the adapter additionally runs two bounded, read-only queries against the standard Prometheus meta-metrics `up` and `scrape_samples_scraped`, grouped by `job`. It ranks jobs by samples scraped per cycle and counts the currently observed target series, including targets whose current `up` value is `0`, for those same ranked jobs.

This is entirely optional: if the query capability isn't advertised, or a query fails, exceeds local analysis bounds, or returns an unrecognized shape, the report still completes with the existing reference-status findings — a warning is added and the scrape-volume section is omitted.

This section identifies scrape-volume configuration hotspots. It does not measure scrape frequency, prove duplicate collection, or estimate exact samples-per-second or byte savings. Confirm intervals, target fan-out, and redundant collection against the collection configuration before changing anything.
