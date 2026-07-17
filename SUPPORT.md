# Support

Telemetry Diet is an open source project maintained on a best-effort basis. Public support covers this repository and the bundled sample workflow; it does not replace support from Datadog, Last9, or another MCP provider.

## Choose the right channel

- [Report a reproducible bug](https://github.com/last9/telemetry-diet/issues/new?template=bug_report.md) when current behavior differs from the documented contract.
- [Propose an improvement](https://github.com/last9/telemetry-diet/issues/new?template=feature_request.md) by describing the problem and desired outcome.
- [Ask a usage question](https://github.com/last9/telemetry-diet/issues/new?template=question.md) when setup or documented behavior is unclear.
- Report a vulnerability privately using [SECURITY.md](SECURITY.md).
- Report community conduct concerns privately using [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Account access, billing, provider uptime, and provider-side RBAC problems belong in that provider's support channel unless Telemetry Diet is constructing an incorrect request.

## Before opening an issue

1. Search open and closed issues for the same behavior.
2. Reproduce with the latest Telemetry Diet release and a supported Node.js version.
3. Try the bundled sample MCP to determine whether the problem is provider-specific.
4. Record `telemetry-diet --version`, `node --version`, operating system, install method, provider, workflow, and exact reproduction steps.
5. Replace production names and values with synthetic equivalents.

## Data safety

Never attach credentials, OAuth tokens, `.telemetry-diet.json`, raw production telemetry, private provider responses, or unreviewed generated reports. Redaction is defense in depth, not permission to publish operational data. If sanitized evidence is insufficient to describe a security problem, use the private vulnerability-reporting path.
