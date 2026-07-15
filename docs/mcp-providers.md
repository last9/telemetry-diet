# MCP provider setup

## Provider login

The default Datadog and Last9 paths use the official hosted Streamable HTTP MCP endpoints and provider OAuth. Telemetry Diet implements the MCP authorization flow locally with PKCE and OAuth state validation. Tokens remain in process memory, never enter browser application state, and are discarded when the CLI stops.

Datadog needs no default configuration. Last9's hosted endpoint is organization-scoped, so set `TELEMETRY_DIET_LAST9_ORG_SLUG` or place the non-secret `last9OrgSlug` in `.telemetry-diet.json` before launch.

Telemetry Diet is an MCP client. It does not require Datadog or Last9 to implement a custom `o11y_*` protocol. Each adapter inspects `tools/list`, selects known provider tools, supplies arguments based on each tool's advertised input schema, and normalizes the result into the internal telemetry-summary model.

## Transports

Both vendor adapters support:

- **Streamable HTTP:** set `TELEMETRY_DIET_<PROVIDER>_MCP_URL`; optionally set `TELEMETRY_DIET_<PROVIDER>_MCP_TOKEN` for an existing bearer flow.
- **stdio:** set `TELEMETRY_DIET_<PROVIDER>_MCP_COMMAND` to a JSON command array or command string. Optional extra arguments can be a JSON array in `TELEMETRY_DIET_<PROVIDER>_MCP_ARGS`.

Examples:

```bash
export TELEMETRY_DIET_DATADOG_MCP_COMMAND='["npx","-y","YOUR_DATADOG_MCP_PACKAGE"]'
export TELEMETRY_DIET_LAST9_MCP_URL='http://127.0.0.1:8090/mcp'
```

Commands inherit the local process environment. Keep vendor secrets there or use the MCP server's existing auth flow; the browser never receives configured URLs, tokens, commands, or vendor credentials.

## Datadog read path

Required capabilities:

| Stage | MCP tool | Behavior |
| --- | --- | --- |
| Service discovery | `search_datadog_services` | Reads matching services. |
| Summary first | `analyze_datadog_logs` | Runs SQL-style overview and fingerprint/path aggregate queries before considering details. |
| Detail fallback | `search_datadog_logs` | Requests at most 10 events only when aggregates lack examples required for a finding. |

Queries scope to `service:<service>` and, when selected, `env:<environment>`. The selected ISO start/end window is mapped into the tool's advertised `from`/`to`, `start`/`end`, or time-window properties.

Some MCP servers return a provider total plus a bounded page. In that case, the total is retained as `recordsAnalyzed`, while field uniqueness and message fingerprints are explicitly described as sample-based. Set `TELEMETRY_DIET_DATADOG_SERVICE` when service search is permission-restricted but a known service is readable. Environment choices default to `production,staging` and can be overridden with `TELEMETRY_DIET_DATADOG_ENVIRONMENTS`.

Datadog MCP can expose sensitive event details when the user's Datadog permissions allow them. Telemetry Diet requires the corresponding Datadog log-read permission and never bypasses RBAC. Returned detail events exist only long enough to build a locally redacted summary; they are not retained in the adapter result or sent to AI.

No monitor, dashboard, notebook, pipeline, or other Datadog write tool is resolved or called.

## Last9 read path

Required capabilities:

| Stage | MCP tool | Behavior |
| --- | --- | --- |
| Service context | `get_service_summary` | Reads service-level context. |
| Environment discovery | `get_service_environments` | Reads selectable environments when available. |
| Field discovery | `get_log_attributes` | Reads the provider's human-readable attribute catalog. It is not treated as cardinality data. |
| Bounded log sample | `get_service_logs` | Requests at most 200 records for local deterministic analysis. |
| Existing policy | `get_drop_rules` | Reads current rules for report context. |
| Discovery help | `did_you_mean` | Reads suggestions when the server exposes no service-list tool. |

Set `TELEMETRY_DIET_LAST9_SERVICE` for servers whose `get_service_summary` requires a service and whose `did_you_mean` response is not a service list. `TELEMETRY_DIET_LAST9_ENVIRONMENTS` supplies a comma-separated fallback when environment discovery is unavailable.

The Last9 adapter follows the provider's response contracts directly: service summaries are a map with exported fields such as `ServiceName`, environments are a JSON string array, logs use `{ count, logs }`, and drop rules can be an array or a rules wrapper. `All environments` omits the environment filter because Last9 environment filtering is exact. An empty `logs` array is a valid result for the selected scope, not a connection failure.

Telemetry Diet does not look up or call `add_drop_rule`. The Last9 JSON output sets `draft: true` and `apply: false`.

### Metric usage capabilities

Metric usage inspects the MCP tool catalog and accepts only capabilities advertised as read-only and non-destructive. It requires:

- a metric-name inventory; and
- at least one reference source covering native dashboards, embedded Grafana dashboards, alerts, or entity indicators.

Each query is normalized with its source type, source ID, display path, and update timestamp when supplied. If inventory collection fails, no metric names are returned, or every reference scan fails, the analysis stops instead of producing an incomplete “unused” list.

### Trace Intelligence capabilities

Trace Intelligence prefers a read-only aggregate trace analysis tool. When no aggregate tool exists, it accepts only a recognized trace-search tool with a limit argument and requests no more than 200 records. The fallback groups records locally and discards raw spans; it never returns attribute values, trace/span IDs, credentials, or upstream error payloads.

Aggregate responses may additionally provide `http_route`, `average_duration_ms`, and an explicit `fast_success_candidates.max_average_duration_ms` threshold. These fields enable guarded health-route and fast-success candidates without exposing raw traces. Missing byte or duration measurements remain unknown rather than being inferred. An unrecognized or unbounded tool contract fails closed.

## Normalization and redaction

Provider results are normalized locally into fields, message fingerprints, endpoint aggregates, policy summaries, and scope metadata. If a provider returns structured records, Telemetry Diet:

1. Limits processing to the first 1,000 locally available records; the Datadog adapter requests no more than 10 events for fallback examples and the Last9 adapter requests no more than 200 records when aggregate analysis is unavailable.
2. Computes fingerprints and uniqueness ratios in memory.
3. Redacts likely email, bearer/JWT, API-key, session, and request identifiers.
4. Discards the raw record array before returning the summary to the web app.

Datadog and Last9 do not share a response contract. Each adapter owns its provider-specific parsing, while shared helpers only handle redaction and the normalized summary model. If a required analysis response has an unknown shape, Telemetry Diet stops with an explicit normalization error instead of guessing a production policy.

## Hosted demo boundary

The launch app is local-first. A public hosted deployment should expose only the bundled sample MCP unless it has a separately reviewed secret and auth design. Do not proxy arbitrary vendor MCP tokens through a public demo.
