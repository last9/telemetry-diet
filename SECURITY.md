# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, tokens, raw telemetry, or exploit details.

Include the affected version, reproduction steps using synthetic data, impact, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure after a fix is available.

## Trust boundary

Telemetry Diet runs on a loopback-only HTTP server and uses read-only provider tools. The server validates Host and Origin boundaries, remote MCP and OAuth endpoints require HTTPS, and OAuth tokens remain in process memory. The app does not send raw telemetry to an AI service and does not implement production policy writes.

Raw log and trace tools require advertised result bounds. Returned arrays are normalized locally; raw arrays and unknown provider fields are discarded before results reach the browser. Redaction uses field names as well as value patterns, but it is not a data-loss-prevention guarantee. Metric references retain query text for provenance. All exported reports can contain operationally sensitive context and should be reviewed before sharing or handled according to the source organization's access policy.

Custom stdio MCP children do not inherit the full parent environment. Only basic process settings and variables named in the provider-specific `MCP_ENV_ALLOWLIST` are passed to the child.

Generated OTel, OTTL, and Last9 policies are visible export-only drafts. Operators must review, pilot, measure, and test them before deployment.
