# MCP provider setup

## Provider login

The default Datadog and Last9 paths use the official hosted Streamable HTTP MCP endpoints and provider OAuth. Telemetry Diet implements the MCP authorization flow locally with PKCE and OAuth state validation. Tokens remain in process memory, never enter browser application state, and are discarded when the CLI stops.

Datadog and Last9 need no default endpoint configuration. Last9 uses its organization-independent hosted MCP endpoint and resolves account context during provider login. Telemetry Diet requests only the Last9 `read` OAuth scope.

Telemetry Diet is an MCP client. It does not require Datadog or Last9 to implement a custom `o11y_*` protocol. Each adapter inspects `tools/list`, selects known provider tools, supplies arguments based on each tool's advertised input schema, and normalizes the result into the internal telemetry-summary model.

## Transports

Both vendor adapters support:

- **Streamable HTTP:** set `TELEMETRY_DIET_<PROVIDER>_MCP_URL`; optionally set `TELEMETRY_DIET_<PROVIDER>_MCP_TOKEN` for an existing bearer flow. Remote endpoints must use HTTPS; loopback HTTP is allowed for local servers.
- **stdio:** set `TELEMETRY_DIET_<PROVIDER>_MCP_COMMAND` to a JSON command array or command string. Optional extra arguments can be a JSON array in `TELEMETRY_DIET_<PROVIDER>_MCP_ARGS`.

Examples:

```bash
export TELEMETRY_DIET_DATADOG_MCP_COMMAND='["npx","-y","YOUR_DATADOG_MCP_PACKAGE"]'
export TELEMETRY_DIET_DATADOG_MCP_ENV_ALLOWLIST='DD_API_KEY,DD_APP_KEY'
export TELEMETRY_DIET_LAST9_MCP_URL='http://127.0.0.1:8090/mcp'
```

Stdio commands inherit a small set of process settings needed to start (`PATH`, home/temp/locale settings, proxy settings, and certificate paths). They do not inherit the full parent environment. When a child server needs specific variables, list their names in `TELEMETRY_DIET_<PROVIDER>_MCP_ENV_ALLOWLIST`, separated by commas. The browser never receives configured URLs, tokens, commands, allowlisted values, or vendor credentials.

## Datadog read path

Use a dedicated Datadog role with only the provider permissions needed by this path:

- `mcp_read` (not `mcp_write`)
- Service Catalog Read for `search_datadog_services`
- Logs Read Data and Logs Read Index Data for log access
- Timeseries for `analyze_datadog_logs`

OAuth reflects the Datadog principal's RBAC. Telemetry Diet also refuses known write tools at runtime, but that is defense in depth: it does not remove privileges from an over-scoped OAuth token. If the consent page offers write access, cancel the flow and correct the Datadog role before connecting.

Required capabilities:

| Stage | MCP tool | Behavior |
| --- | --- | --- |
| Service discovery | `search_datadog_services` | Reads matching services. |
| Summary first | `analyze_datadog_logs` | Runs SQL-style overview and fingerprint/path aggregate queries before considering details. |
| Detail fallback | `search_datadog_logs` | Used only when aggregates lack examples and the schema advertises an enforceable result-limit field; requests at most 10 events. |

Queries scope to `service:<service>` and, when selected, `env:<environment>`. The selected ISO start/end window is mapped into the tool's advertised `from`/`to`, `start`/`end`, or time-window properties.

Some MCP servers return a provider total plus a bounded page. In that case, the total is retained as `recordsAnalyzed`, while field uniqueness and message fingerprints are explicitly described as sample-based. Set `TELEMETRY_DIET_DATADOG_SERVICE` when service search is permission-restricted but a known service is readable. Environment choices default to `production,staging` and can be overridden with `TELEMETRY_DIET_DATADOG_ENVIRONMENTS`.

Datadog MCP can expose sensitive event details when the user's Datadog permissions allow them. Telemetry Diet requires the corresponding Datadog log-read permission and never bypasses RBAC. Returned detail events exist only long enough to build a locally redacted summary; they are not retained in the adapter result. If the detail tool has no enforceable result-limit field, Telemetry Diet skips it and returns aggregate evidence with an explicit limitation. An over-limit response is rejected.

No monitor, dashboard, notebook, pipeline, or other Datadog write tool is resolved or called.

## Last9 read path

Required capabilities:

| Stage | MCP tool | Behavior |
| --- | --- | --- |
| Service context | `get_service_summary` | Reads service-level context. |
| Environment discovery | `get_service_environments` | Reads selectable environments when available. |
| Field discovery | `get_log_attributes` | Reads the provider's human-readable attribute catalog. It is not treated as cardinality data. |
| Log sample | `get_service_logs` | Must advertise an enforceable result-limit field; requests at most 200 records and rejects an over-limit response. |
| Existing policy | `get_drop_rules` | Reads current rules for report context. |
| Discovery help | `did_you_mean` | Reads suggestions when the server exposes no service-list tool. |

Set `TELEMETRY_DIET_LAST9_SERVICE` for servers whose `get_service_summary` requires a service and whose `did_you_mean` response is not a service list. `TELEMETRY_DIET_LAST9_ENVIRONMENTS` supplies a comma-separated fallback when environment discovery is unavailable.

The Last9 adapter follows the provider's response contracts directly: service summaries are a map with exported fields such as `ServiceName`, environments are a JSON string array, logs use `{ count, logs }`, and drop rules can be an array or a rules wrapper. `All environments` omits the environment filter because Last9 environment filtering is exact. An empty `logs` array is a valid result for the selected scope, not a connection failure.

Telemetry Diet does not look up or call `add_drop_rule`. The Last9 JSON output sets `draft: true` and `apply: false`.

### Metric usage capabilities

Metric usage inspects the MCP tool catalog and accepts only capabilities advertised as read-only and non-destructive. It requires:

- a metric-name inventory; and
- at least one reference source covering native dashboards, embedded Grafana dashboards, alerts, or entity indicators.

The official Last9 MCP path uses `prometheus_label_values` with `label: __name__` for inventory. Native dashboards are deliberately two-step: `list_dashboards` supplies bounded IDs and metadata, then `get_dashboard` reads each full definition so panel PromQL is actually scanned. Alert and KPI PromQL comes from the read-only `get_alert_config` response. `get_alerts` is not used for metric references because it reports currently firing alerts, not alert definitions.

Each query is normalized with its source type, source ID, display path, and update timestamp when supplied. If inventory collection fails, no metric names are returned, or every reference scan fails, the analysis stops instead of producing an incomplete “unused” list.

### Trace Intelligence capabilities

Trace Intelligence prefers a read-only aggregate trace analysis tool. When no aggregate tool exists, it accepts only a recognized trace-search tool with a limit argument and requests no more than 200 records. The fallback groups records locally and discards raw spans; it never returns attribute values, trace/span IDs, credentials, or upstream error payloads.

The official Last9 fallback is `get_service_traces`. Its `SPAN_KIND_*` and `STATUS_CODE_*` values are normalized before analysis; exported trace IDs and span IDs are discarded. This fallback does not currently expose measured export bytes, instrumentation scope, or leaf/business-span evidence, so Telemetry Diet does not invent those fields or generate corresponding drop recommendations from that response alone.

Aggregate responses may additionally provide `http_route`, `average_duration_ms`, and an explicit `fast_success_candidates.max_average_duration_ms` threshold. These fields enable guarded health-route and fast-success candidates without exposing raw traces. Missing byte or duration measurements remain unknown rather than being inferred. An unrecognized or unbounded tool contract fails closed.

## Normalization and redaction

Provider results are normalized locally into fields, message fingerprints, endpoint aggregates, policy summaries, and scope metadata. If a provider returns structured records, Telemetry Diet:

1. Calls raw-record tools only when their schema advertises an enforceable result limit. The Datadog detail path requests at most 10 examples and the Last9 log path requests at most 200 records; over-limit responses are rejected.
2. Computes fingerprints and uniqueness ratios in memory.
3. Redacts likely email, bearer/JWT, API-key, password, secret, session, and request values using both field names and value patterns.
4. Keeps only the normalized evidence model and discards raw arrays and unknown provider fields before returning the summary to the web app.

Datadog and Last9 do not share a response contract. Each adapter owns its provider-specific parsing, while shared helpers only handle redaction and the normalized summary model. If a required analysis response has an unknown shape, Telemetry Diet stops with an explicit normalization error instead of guessing a production policy.

## Hosted demo boundary

The app server binds only to `localhost`, `127.0.0.1`, or `::1`. It rejects DNS-rebinding Host values, cross-origin/cross-site requests, non-JSON API writes, and analysis windows longer than seven days. A public hosted deployment should expose only the bundled sample MCP unless it has a separately reviewed secret and auth design. Do not proxy arbitrary vendor MCP tokens through a public demo.
