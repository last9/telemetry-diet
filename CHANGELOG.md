# Changelog

All notable changes to Telemetry Diet are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-08-17

### Added

- Added an optional Last9 metric scrape-volume configuration review that uses bounded, read-only PromQL to rank high-volume scrape jobs and surface target fan-out for operator validation.

### Changed

- Switched npm releases to OIDC trusted publishing with provenance, a verified package tarball, and a CycloneDX production-dependency SBOM attached to each GitHub release.
- Updated the MCP SDK, PromQL parser, lint toolchain, release actions, and patched transitive dependencies.

### Fixed

- Updated the default Last9 OAuth flow to use the organization-independent hosted MCP endpoint with an explicit read-only scope; an organization slug is no longer required.
- Allowed provider OAuth callback redirects through the cross-site guard while continuing to reject cross-site subresource and non-navigation requests.

## [0.1.0] - 2026-07-17

First public release.

### Added

- Local, read-only log analysis for the bundled sample MCP and Last9, plus a beta Datadog path.
- Deterministic findings for telemetry noise, risky fields, cardinality, and naming drift.
- Export-only Markdown, OpenTelemetry Collector, OTTL, and Last9 policy drafts.
- Beta Last9 metric-reference coverage and trace-reduction workflows.
- Provider OAuth with in-memory credentials and bounded, normalized evidence handling.
- Public artifact schema, package checks, coverage thresholds, and community contribution paths.

### Security

- Loopback-only HTTP serving with Host, Origin, content-type, and scope validation.
- Read-only MCP tool enforcement, restricted stdio child environments, HTTPS requirements, and sanitized provider errors.
- Field-aware pattern redaction before evidence reaches the browser or an export.

[Unreleased]: https://github.com/last9/telemetry-diet/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/last9/telemetry-diet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/last9/telemetry-diet/releases/tag/v0.1.0
