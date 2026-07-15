# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, tokens, raw telemetry, or exploit details.

Include the affected version, reproduction steps using synthetic data, impact, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure after a fix is available.

## Trust boundary

Telemetry Diet runs locally and uses read-only provider tools. OAuth tokens remain in process memory. The app does not send raw logs to an AI service and does not implement production policy writes.

Generated OTel and Last9 policies are drafts. Operators must review and test them before deployment.
