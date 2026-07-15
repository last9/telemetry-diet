# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, tokens, raw telemetry, or exploit details.

Include the affected version, reproduction steps using synthetic data, impact, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure after a fix is available.

## Trust boundary

Telemetry Diet runs locally and uses read-only provider tools. OAuth tokens remain in process memory. The app does not send raw telemetry to an AI service and does not implement production policy writes.

Raw log and trace records are bounded, normalized, and discarded before results reach the browser. Metric references retain query text for provenance; exported reports should therefore be handled according to the source organization's access policy.

Generated OTel, OTTL, and Last9 policies are visible export-only drafts. Operators must review, pilot, measure, and test them before deployment.
