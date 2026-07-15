# Telemetry Diet

> Telemetry Diet is an OSS MCP app that connects read-only to observability data, finds noisy logs, underused metrics, and evidence-backed trace reduction candidates, then exports reviewable drafts before you change production.

Telemetry Diet is a local telemetry analysis workbench, not a dashboard or hosted telemetry-pasting service. Its three separate workflows are deterministic and read-only:

- **Logs** analyzes a selected service and time window for noise, risky fields, and cardinality problems.
- **Metrics** compares the organization metric inventory with PromQL references in dashboards, alerts, and indicators.
- **Traces** ranks measured reduction candidates while preserving service boundaries, errors, and business spans.

```bash
npx telemetry-diet
```

The command starts a local app on `127.0.0.1` and opens the workbench. Datadog and Last9 authentication happens on the providers' own consent pages; OAuth tokens are held in the local process and are not exposed to the browser app. Node.js 22 or newer is required.

## Fast demo: no credentials

From this repository:

```bash
npm install
npm start
```

Open the printed local URL, then:

1. Click **Connect sample MCP**.
2. Keep `checkout-api`, `production`, and `Last 6 hours` selected.
3. Choose **Logs**, **Metrics**, or **Traces**, then click the analysis button.
4. Inspect 13 deterministic findings, including successful health checks, DEBUG noise, risky fields, high-cardinality fields, and resource naming drift.
5. Toggle policy suggestions and watch the directional before/after preview update.
6. Inspect or download the Markdown report, OTel/OTTL draft, and Last9 draft JSON.

The bundled sample is served by a real local stdio MCP server. It contains generic, already-redacted examples for every workflow; no credentials or pasted telemetry are needed.

## Connect Datadog MCP

Telemetry Diet uses the configured Datadog MCP server's actual read-only tools:

- `search_datadog_services` for discovery
- `analyze_datadog_logs` for aggregate analysis
- `search_datadog_logs` for a bounded detail fallback when aggregates are insufficient

Click **Log in with Datadog**. Telemetry Diet connects to Datadog's hosted MCP endpoint, opens Datadog OAuth in a provider window, validates the localhost callback, and reconnects automatically. There is no Datadog CLI or API-key setup in the default flow.

Advanced: override the Datadog site endpoint or use an existing bearer token:

```bash
export TELEMETRY_DIET_DATADOG_MCP_URL='http://127.0.0.1:8080/mcp'
export TELEMETRY_DIET_DATADOG_MCP_TOKEN='optional-existing-mcp-token'
npx telemetry-diet
```

Or a local stdio command. A JSON array avoids shell quoting ambiguity:

```bash
export TELEMETRY_DIET_DATADOG_MCP_COMMAND='["npx","-y","YOUR_DATADOG_MCP_PACKAGE"]'
export TELEMETRY_DIET_DATADOG_SERVICE='checkout-api' # optional discovery fallback
npx telemetry-diet
```

Provider-specific Datadog credentials belong to that MCP server's environment. Telemetry Diet does not ask for them in the browser and never calls Datadog write tools.

Datadog permissions still govern every result. Telemetry Diet requires log-read access and does not bypass RBAC. It calls `analyze_datadog_logs` first with SQL-style aggregate queries for counts, cardinality, top paths, severities, and message fingerprints. `search_datadog_logs` is only a fallback for at most 10 event examples; those examples are redacted locally and the raw events are discarded before UI/report generation.

## Connect Last9 MCP

The Last9 log adapter targets:

- `get_service_summary`
- `get_service_environments`
- `get_service_logs`
- `get_log_attributes`
- `get_drop_rules`
- `did_you_mean` when available

The Last9 hosted endpoint includes the organization slug from `app.last9.io/<org_slug>/…`. Once that non-secret endpoint is configured, click **Log in with Last9** and complete OAuth on Last9. OAuth tokens stay in the local Telemetry Diet process and expire when it stops.

For another organization, set the slug before starting the app:

```bash
export TELEMETRY_DIET_LAST9_ORG_SLUG='your-org'
npx telemetry-diet
```

Configure hosted/HTTP MCP:

```bash
export TELEMETRY_DIET_LAST9_MCP_URL='https://YOUR_LAST9_MCP_ENDPOINT/mcp'
export TELEMETRY_DIET_LAST9_MCP_TOKEN='your-existing-mcp-token'
export TELEMETRY_DIET_LAST9_SERVICE='checkout-api'
npx telemetry-diet
```

Or stdio:

```bash
export TELEMETRY_DIET_LAST9_MCP_COMMAND='["node","/path/to/last9-mcp-server.js"]'
export TELEMETRY_DIET_LAST9_SERVICE='checkout-api'
npx telemetry-diet
```

`TELEMETRY_DIET_LAST9_SERVICE` is recommended when the MCP server has no global service-list tool. Existing drop rules are read for context. The generated Last9 policy is an export-only draft: there is no `add_drop_rule` or other write path in this launch version.

Metric usage dynamically resolves a read-only metric inventory plus at least one reference source: native dashboards, embedded Grafana dashboards, alerts, or entity indicators. Trace Intelligence prefers an aggregate trace-analysis capability and can use only a bounded trace-search fallback. Both workflows fail closed when the required read contract is unavailable or unrecognized.

See [provider setup](docs/mcp-providers.md) for transport and response-normalization details.

## Metric usage

Metric usage uses a PromQL syntax tree rather than regular expressions. It reports each metric as referenced in multiple scanned sources, referenced once, or unreferenced in the scanned sources. Protection policy is a separate flag; it never silently turns an unreferenced metric into a referenced one.

The report is organization-wide and includes exact query provenance. It does not observe ad hoc queries or external consumers, so an unreferenced result is a review candidate, not proof that a metric is unused. See [metric usage](docs/metric-usage.md).

## Trace Intelligence

Trace Intelligence ranks measured bytes before span counts and considers these guarded levers in order:

1. Resource-attribute trimming that preserves critical service and SDK attributes.
2. Conservative UUID and long-hex span-name normalization when multiple names collapse to one redacted pattern.
3. Selective redundant instrumentation disablement while retaining the paired boundary span.
4. Exact low-value or health-route `INTERNAL` leaf filters that exclude errors, business spans, and protected boundary spans.
5. Fast-success cohorts as review-only sampling candidates with an explicit measured-duration threshold.
6. Residual head sampling as a final lever, with explicit APM and error-visibility caveats.

Generated OTel Collector and OTTL text is visibly marked **EXPORT-ONLY DRAFT** and is never applied. See [Trace Intelligence](docs/trace-intelligence.md).

## What the analyzer proves

The deterministic log analyzer detects:

- successful `/health`, `/healthz`, `/ready`, `/live`, and `/metrics` traffic
- DEBUG/TRACE noise and repeated message fingerprints
- likely email, API key, bearer, secret, and session-token fields
- high-cardinality fields using presence and uniqueness ratios
- `service`/`service.name`/`app` and environment naming drift
- fields that are unsafe as labels, tags, facets, or routing keys

Every finding includes confidence, affected records in the selected window, redacted examples, a suggested action, limitations, and a rule fragment where the target supports it. Small samples are labeled as **sample impact** or **directional reduction**, never exact savings.

## Generated outputs

Outputs depend on the selected workflow: logs produce a Markdown report plus OTel/OTTL and Last9 policy drafts; metrics produce Markdown and JSON usage reports; traces produce Markdown plus OTel Collector/OTTL export-only drafts.

Generated semantics and portability limits are documented in [policy outputs](docs/policy-output.md).

## Safety boundary

> AI explains. Analyzer proves. Human applies.

- Provider OAuth plus read-only MCP calls only; no production write implementation ships.
- Raw records are summarized locally and are not sent to an AI service.
- Metric query definitions and trace aggregates are normalized locally; raw trace records are never returned to the browser.
- Examples are redacted at the provider boundary and again before the UI/report.
- Generated configuration is always visible and export-only.
- Existing Last9 rules are context, not mutation targets.
- Drafts can affect incident response, compliance, and retention. Test and review them before deployment.

Telemetry Diet does not provide exact cost estimation, automated rollout, Datadog writes, Last9 writes, a hosted multi-tenant backend, or production policy application.

## Architecture

```text
Sample MCP  ─┐
Datadog MCP ─┼─> signal adapter ─> normalized, bounded evidence
Last9 MCP  ──┘                              │
                                            v
                          deterministic signal analyzer
                                            │
                             report + visible export drafts
```

```text
bin/                 CLI and sample MCP executables
src/core/            log analyzer, redaction, preview, policy, report
src/metric-usage/    PromQL parsing, protection policy, usage reports
src/trace-intelligence/ byte-first reduction analysis and draft exports
src/mcp/             stdio client/server and Streamable HTTP client
src/providers/       sample, Datadog, and Last9 adapters
src/sample/          bundled sample scenario
web/                 dependency-free local workbench
test/                deterministic and MCP integration tests
```

Run project checks with:

```bash
npm test
npm run check
npm run pack:check
```

## Reddit-ready demo flow

Suggested launch framing:

> I built Telemetry Diet, an OSS MCP app that connects read-only to Datadog or Last9, finds noisy/risky logs, and generates a tested OTel drop/redact policy before you change production.

Demo sequence: run `npx telemetry-diet`, connect the credentialless sample MCP, analyze `checkout-api / production / 6h`, toggle the health-check and DEBUG suggestions, show the deterministic 2,000 → 1,240 directional preview, then open the OTTL and Last9 JSON tabs to show that the exact drafts are inspectable and never auto-applied.

License: Apache-2.0.
