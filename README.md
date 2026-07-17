# Telemetry Diet

> Find telemetry you can safely trim—locally, read-only, with drafts you review and apply.

Telemetry Diet is a local observability optimization workbench for platform and observability engineers. It uses read-only MCP tools to gather provider evidence, analyzes that evidence deterministically, and exports reviewable drafts without applying production changes.

Logs are the primary supported workflow. Last9 metric-reference and trace-reduction workflows are beta previews:

| Workflow | Bundled sample | Datadog | Last9 |
| --- | --- | --- | --- |
| Log noise, privacy, and cardinality analysis | Included | Supported | Supported |
| Metric reference coverage | Beta preview | Not supported | Beta preview |
| Trace reduction candidates | Beta preview | Not supported | Beta preview |

Telemetry Diet is not a dashboard, hosted telemetry service, or automatic policy rollout system. MCP is the read-only integration layer; the product outcome is evidence you can review before changing telemetry collection.

```bash
npx telemetry-diet
```

The command starts a local app on `127.0.0.1` and opens the workbench. Datadog and Last9 authentication happens on the providers' own consent pages; OAuth tokens are held in the local process and are not exposed to the browser app. Node.js 22.13 or newer is required.

## Run locally from source

Prerequisites: Git, Node.js 22.13 or newer, and npm.

```bash
git clone https://github.com/last9/telemetry-diet.git
cd telemetry-diet
npm install
npm start
```

`npm start` runs the local workbench without opening a browser automatically. Open the URL printed in the terminal, normally `http://127.0.0.1:4545`. No hosted backend, database, or credentials are required for the sample MCP path.

Use watch mode while developing:

```bash
npm run dev
```

To use another port:

```bash
npm start -- --port 4571
```

Stop the local server with `Ctrl+C`. Before submitting changes, run the complete local quality gate:

```bash
npm run verify
```

The gate checks tracked text/JSON hygiene, lints and syntax-checks every JavaScript file, runs the test suite with source-only coverage thresholds, and validates the npm package manifest. `npm test` remains the faster test-only command.

Provider environment variables can be set in the same shell before `npm start`; see [Datadog MCP](#connect-datadog-mcp-for-logs), [Last9 MCP](#connect-last9-mcp), and the detailed [provider setup guide](docs/mcp-providers.md).

## Fast demo: no credentials

With the local app running:

1. Click **Connect sample MCP**.
2. Keep `checkout-api`, `production`, and `Last 6 hours` selected.
3. Keep **Logs** selected and click **Analyze selected window**.
4. Inspect 13 deterministic findings, including successful health checks, DEBUG noise, risky fields, high-cardinality fields, and resource naming drift.
5. Toggle policy suggestions and watch the directional before/after preview update.
6. Inspect or download the Markdown report, OTel/OTTL draft, and Last9 draft JSON. Then try the beta metric and trace workflows with the same sample connection.

The bundled sample is served by a real local stdio MCP server. It contains generic, already-redacted examples for every workflow; no credentials or pasted telemetry are needed.

## Connect Datadog MCP for logs

Telemetry Diet uses the configured Datadog MCP server's actual read-only tools:

- `search_datadog_services` for discovery
- `analyze_datadog_logs` for aggregate analysis
- `search_datadog_logs` for a detail fallback when aggregates are insufficient

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
# Only names listed here are copied from the parent environment into the MCP child.
export TELEMETRY_DIET_DATADOG_MCP_ENV_ALLOWLIST='DD_API_KEY,DD_APP_KEY' # when required by that server
npx telemetry-diet
```

Provider-specific Datadog credentials belong to that MCP server's environment. Stdio MCP children receive basic process settings plus only the credential names explicitly listed in `TELEMETRY_DIET_DATADOG_MCP_ENV_ALLOWLIST`; unrelated parent-process secrets are not inherited. Telemetry Diet does not ask for credentials in the browser and never calls Datadog write tools.

Datadog permissions still govern every result. Use a dedicated Datadog role with `mcp_read`, Service Catalog Read, Logs Read Data, Logs Read Index Data, and Timeseries; do not grant `mcp_write`. Telemetry Diet's runtime rejection of write tools is defense in depth and cannot narrow an over-privileged provider token. It embeds the selected service and environment in its SQL-style aggregate queries for counts, cardinality, top paths, severities, and message fingerprints. It calls `search_datadog_logs` only when the tool advertises an enforceable result-limit field, requests at most 10 examples, rejects an over-limit response, redacts the examples, and discards the raw event array before UI/report generation. Without that limit contract, aggregate analysis continues without detail examples.

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
# Example when the child server needs selected credentials from this shell:
export TELEMETRY_DIET_LAST9_MCP_ENV_ALLOWLIST='LAST9_API_TOKEN'
npx telemetry-diet
```

`TELEMETRY_DIET_LAST9_SERVICE` is recommended when the MCP server has no global service-list tool. Existing drop rules are read for context. The generated Last9 policy is an export-only draft: there is no `add_drop_rule` or other write path.

Last9 log analysis is the primary supported workflow for this provider. The metric and trace workflows are beta previews. Metric reference coverage dynamically resolves a read-only metric inventory plus at least one reference source: native dashboards, embedded Grafana dashboards, alerts, or entity indicators. Trace Intelligence prefers an aggregate trace-analysis capability and can use only a trace-search fallback with an advertised result limit. Both beta workflows fail closed when the required read contract is unavailable or unrecognized.

See [provider setup](docs/mcp-providers.md) for transport and response-normalization details.

## Metric reference coverage — beta

Metric reference coverage uses a PromQL syntax tree rather than regular expressions. It reports each metric as referenced by multiple scanned queries, referenced once, or unreferenced in the scanned sources. A single reference is a review signal, not evidence that the metric is unimportant. Protection policy is a separate flag; it never silently turns an unreferenced metric into a referenced one.

The report is organization-wide and includes exact query provenance. It does not observe ad hoc queries or external consumers, so an unreferenced result is a review candidate, not proof that a metric is unused. See [metric usage](docs/metric-usage.md).

## Trace Intelligence — beta

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

Maintainers can validate representative log and trace drafts against an installed OpenTelemetry Collector Contrib binary:

```bash
npm run validate:artifacts -- --collector /path/to/otelcol-contrib
```

The check also validates Last9 JSON against the published [`telemetry-diet.last9-draft/v1` schema](schemas/telemetry-diet.last9-draft.v1.schema.json).

## Safety boundary

> Evidence first. Human reviewed. You apply.

- Provider OAuth plus read-only MCP calls only; no production write implementation ships.
- The web server binds only to a loopback address and rejects mismatched Host, cross-origin, and cross-site requests.
- Raw records are summarized locally and are not sent to an AI service.
- Metric query definitions and trace aggregates are normalized locally; raw trace records are never returned to the browser.
- Provider evidence is processed locally and passed through pattern-based redaction before UI/report generation. Treat exported reports as sensitive until reviewed.
- Generated configuration is always visible and export-only.
- Existing Last9 rules are context, not mutation targets.
- Drafts can affect incident response, compliance, and retention. Test and review them before deployment.

Telemetry Diet does not provide exact cost estimation, automated rollout, Datadog writes, Last9 writes, a hosted multi-tenant backend, production policy application, or AI analysis.

## Architecture

```text
Sample MCP  ─┐
Datadog MCP ─┼─> signal adapter ─> normalized provider evidence
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

## Community

- Read [SUPPORT.md](SUPPORT.md) before opening a question or bug report.
- See [CONTRIBUTING.md](CONTRIBUTING.md) to develop and test a change.
- Report vulnerabilities using the private process in [SECURITY.md](SECURITY.md), never a public issue.
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
