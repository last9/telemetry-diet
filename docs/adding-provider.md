# Add an observability provider

Telemetry Diet integrates with observability providers through read-only MCP tools. A provider adapter discovers a deliberately small set of known tools, sends a bounded scope, and converts provider-specific responses into Telemetry Diet's internal evidence model.

Providers are not loaded dynamically. Each supported provider is wired explicitly through the server and workbench so its authentication, tool contracts, safety boundaries, and user-facing support level can be reviewed together.

This guide covers the complete path for adding a provider. Start with logs; metric-reference and trace-reduction support have separate evidence contracts and should be added only when the provider exposes enough bounded, read-only data.

## 1. Define the provider contract first

Before writing the adapter, document the exact MCP capabilities you intend to use. For every tool, record:

| Contract item | What to establish |
| --- | --- |
| Tool identity | Exact tool name and the upstream server/version or commit used for the contract. |
| Read boundary | Why the tool is read-only and which least-privilege provider permissions it needs. |
| Scope | How service, environment, and absolute start/end timestamps reach the tool. |
| Result bound | The advertised input field that enforces the maximum result count. |
| Response shape | The fields the adapter reads and how partial, empty, or malformed results behave. |
| Retention | Which normalized fields survive and where raw records are discarded. |

Prefer provider-side summaries and aggregates. A raw-record tool is an optional, last-resort detail path: its input schema must advertise an enforceable result-limit field, the adapter must send that limit, reject an over-limit response, redact locally, and discard the raw array.

Do not select tools from descriptions alone. Add exact, reviewed read aliases and fail closed when the required capabilities are missing, write-shaped, destructive, unbounded, or unfamiliar.

## 2. Choose transport and authentication

Use the shared client in [`src/mcp/client.js`](../src/mcp/client.js). It provides:

- Streamable HTTP with HTTPS required for remote endpoints and HTTP allowed only on loopback;
- stdio with an intentionally small inherited environment;
- explicit credential allowlisting for stdio children;
- response-size and request-time bounds; and
- provider OAuth clients with in-memory credentials.

Use one uppercase environment prefix consistently. For a provider named `acme`, the conventional settings are:

```text
TELEMETRY_DIET_ACME_MCP_URL
TELEMETRY_DIET_ACME_MCP_TOKEN
TELEMETRY_DIET_ACME_MCP_COMMAND
TELEMETRY_DIET_ACME_MCP_ARGS
TELEMETRY_DIET_ACME_MCP_ENV_ALLOWLIST
TELEMETRY_DIET_ACME_SERVICE
TELEMETRY_DIET_ACME_ENVIRONMENTS
```

An stdio server receives only base process settings and variables named in `TELEMETRY_DIET_ACME_MCP_ENV_ALLOWLIST`. Never copy the whole parent environment into an MCP child.

Hosted OAuth is a cross-cutting feature, not an adapter-only change. In addition to creating the OAuth client, add the exact provider key to the server callback allowlist, browser routing, login copy, and OAuth tests. Keep tokens in the local process; URLs, tokens, commands, and allowlisted credential values must not enter `/api/config` or browser state.

## 3. Implement the log adapter

Create `src/providers/acme.js` and implement the same lifecycle as the existing adapters:

```js
export class AcmeAdapter {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.oauth = options.oauth;
    this.provider = 'acme';
    this.readOnly = true;
  }

  async connect() {}
  async discoverServices() {}
  async getEnvironments(service) {}
  async analyze({ service, environment, timeWindow }) {}
  async close() { await this.client?.close(); }
}
```

The methods have these contracts:

| Method | Required behavior |
| --- | --- |
| `connect()` | Create the MCP client, inspect `tools/list`, select only known safe reads, and return `{ provider, readOnly: true, serverInfo, tools }`. Close or fail if required tools are unavailable. |
| `discoverServices()` | Return a sorted, deduplicated string array. Use an explicit configured service fallback when the provider cannot list services. |
| `getEnvironments(service)` | Return a string array. Include `*` only when the adapter can correctly represent an unfiltered environment. |
| `analyze(scope)` | Send the exact service/environment/time scope and return normalized evidence. Unknown response shapes must throw instead of producing an empty success. |
| `close()` | Release HTTP, OAuth, or stdio resources. It must be safe after a partial connection failure. |

Use shared helpers from [`src/providers/helpers.js`](../src/providers/helpers.js) where their contracts fit:

- `findTool()` accepts reviewed aliases while rejecting known write prefixes and unsafe annotations.
- `toolArgs()` maps scope values only into fields advertised by the MCP input schema.
- `resultLimitForTool()` proves that a raw-record tool exposes a usable limit.
- `extractServices()` and `extractEnvironments()` normalize common discovery wrappers.
- `normalizedFromPayload()` can normalize an already-structured summary or a bounded record collection.

Provider-specific parsing belongs in the provider adapter or a sibling normalization module. Do not broaden a shared helper to guess a vendor-only response shape.

## 4. Return the normalized log evidence model

`analyze()` returns an object with this shape:

```js
{
  provider: 'acme',
  service: 'checkout-api',
  environment: 'production',
  timeWindow: { start: '...', end: '...' },
  recordsAnalyzed: 200,
  fields: [{
    name: 'request.id',
    type: 'string',
    presence: 200,
    uniqueCount: 198,
    uniqueRatio: 0.99,
    topValues: [{ value: '[redacted]', count: 2 }],
    examplesRedacted: ['[redacted]'],
  }],
  messages: [{
    fingerprint: 'request completed in ? ms',
    count: 80,
    severity: 'INFO',
    examplesRedacted: ['request completed in 42 ms'],
  }],
  endpoints: [{ path: '/healthz', method: 'GET', statusClass: '2xx', count: 50 }],
  existingPolicies: [],
  limitations: [],
}
```

Build `provider`, selected scope, and `timeWindow` from local inputs rather than trusting echoed provider fields. Preserve provider totals when they are real, but state when uniqueness, fingerprints, or endpoints come from a bounded sample. Missing evidence stays missing; do not turn unavailable counts, bytes, duration, errors, or coverage into zero.

Redact before the adapter returns and before an example reaches a report. Drop raw event/span arrays, credentials, provider error bodies, trace/span IDs, and unknown response fields. The server performs another redaction pass, but that is defense in depth rather than permission for an adapter to return raw data.

## 5. Wire the provider end to end

Add the provider explicitly at each applicable boundary:

| File | Change |
| --- | --- |
| [`src/providers/index.js`](../src/providers/index.js) | Import the adapter and construct it for the exact provider key. |
| [`src/server.js`](../src/server.js) | Add non-secret configuration status, accept the provider in `/api/connect`, and extend the exact OAuth callback allowlist when needed. |
| [`web/index.html`](../web/index.html) | Add the connection button and honest support/authentication copy. |
| [`web/app.js`](../web/app.js) | Add labels, route validation, OAuth behavior, and signal availability. |
| [`web/styles.css`](../web/styles.css) | Add only the provider-specific presentation needed by the new button. |
| `test/` | Update navigation/server harness provider lists and add adapter, contract, safety, and route coverage. |
| [`README.md`](../README.md) | Update the support matrix and add least-privilege setup instructions. |
| [`docs/mcp-providers.md`](mcp-providers.md) | Document the exact tools, transport variables, normalization behavior, and limitations. |

Keep `/api/config` non-secret. It may expose booleans, mode names, and other setup status required by the UI; it must not expose MCP URLs, bearer tokens, command lines, credential names or values, or provider responses.

## 6. Add metrics or traces separately

Connecting a provider for logs does not automatically make its metrics or traces safe or supported. The signal registry in [`src/signals/analysis.js`](../src/signals/analysis.js) is intentionally explicit.

For metric-reference coverage, add a provider-specific collector that returns:

```js
{
  metricNames: ['requests_total'],
  references: [{
    kind: 'dashboard',
    sourceId: 'dashboard-123',
    sourceName: 'Service overview > Request rate',
    query: 'sum(rate(requests_total[5m]))',
    updatedAt: '...',
  }],
  warnings: [],
}
```

The inventory must succeed, and at least one real reference source—dashboard definitions, alert definitions, or indicators—must be scanned. Currently firing alerts are not a substitute for alert definitions. Preserve query provenance, and fail closed rather than marking metrics unused from incomplete coverage.

For trace reduction, add a collector that returns aggregate cohorts compatible with `src/trace-intelligence/`. Prefer measured aggregate bytes and counts. A trace-search fallback is acceptable only with an advertised result limit; group locally and discard raw spans. Do not infer missing bytes, instrumentation scope, errors, leaf status, business meaning, or duration thresholds.

Add each signal to the server and UI only after its independent adapter and tests exist. Update the README support matrix with an accurate status such as experimental, beta, or supported.

## 7. Test failure behavior, not just the happy path

Use synthetic, already-redacted fixtures. At minimum, add tests for:

- exact current tool names and input schemas from the upstream MCP implementation;
- rejection of write-shaped, destructive, or falsely annotated tool variants;
- required service, environment, and absolute time-window arguments;
- aggregate-first call ordering;
- raw-detail omission when no limit is advertised;
- the requested cap and rejection of an over-limit response;
- empty valid results, partial results with visible limitations, and malformed/unknown results;
- local redaction and absence of raw arrays, secret values, and provider-controlled errors;
- service/environment discovery and configured fallbacks;
- cleanup after successful, failed, and OAuth-interrupted connection attempts;
- `/api/config`, connect, analyze, route restore, and signal-availability behavior; and
- generated artifacts remaining visible drafts with no provider write calls.

When an upstream tool contract is public, identify its repository revision in the test next to the frozen contract vector. This makes contract drift reviewable instead of silently accepting a new shape.

Run the complete gate:

```bash
npm run verify
```

Then smoke-test with a dedicated least-privilege account. Exercise service discovery, empty and populated scopes, provider denial, OAuth cancellation/expiry when applicable, and shutdown cleanup. Do not commit credentials, raw production telemetry, real generated reports, or screenshots containing customer data.

## Pull request checklist

- [ ] The PR or linked issue names exact read-only MCP tools and upstream contract versions.
- [ ] Provider permissions are least privilege and exclude write access.
- [ ] The adapter prefers aggregates; every raw request is schema-bounded and over-limit responses fail.
- [ ] Unknown tools and response shapes fail closed.
- [ ] Raw records and provider errors cannot cross the adapter boundary.
- [ ] Logs, metrics, and traces are advertised only where separately implemented and tested.
- [ ] Setup, limitations, support status, and environment variables are public and accurate.
- [ ] Synthetic tests cover secrets, partial evidence, empty evidence, malformed data, and cleanup.
- [ ] `npm run verify` passes, followed by a least-privilege smoke test.

For a substantial provider integration, open an issue before implementation so maintainers can review the evidence contract and safety boundary before the UI and authentication work grows around it.
