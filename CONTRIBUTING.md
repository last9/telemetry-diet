# Contributing

Thanks for helping improve Telemetry Diet. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Telemetry Diet is a local, read-only observability optimization workbench. Contributions must preserve that trust boundary: analyze evidence, generate visible drafts, and leave production changes to the operator.

## Before you start

- Search existing issues before opening a new one.
- Use the issue templates for bugs, feature proposals, and questions.
- For a substantial change, open an issue first so scope and safety tradeoffs can be discussed.
- Never use a public issue for a vulnerability; follow [SECURITY.md](SECURITY.md).

## Development

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm install
npm run verify
npm start
```

Use the bundled sample MCP for development whenever possible. Keep tests deterministic and use synthetic, already-redacted fixtures. Do not commit provider credentials, OAuth tokens, raw production telemetry, generated reports from a real environment, or local `.telemetry-diet.json` files.

`npm run verify` is the required local gate. It checks formatting, lint, syntax, Markdown links, source coverage, and npm package contents.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Keep provider adapters read-only.
- Prefer provider summaries and aggregates over raw records.
- Bound every raw-record request and discard raw arrays after local normalization.
- Redact examples before they cross the provider boundary or enter an export.
- Add focused tests for analyzer, normalization, and policy behavior.
- Describe limitations when a generated rule is provider-specific or best effort.
- Update public documentation when behavior, setup, or a safety boundary changes.
- Include screenshots only for user-interface changes and ensure they contain synthetic data.

Maintainers may ask for a smaller change, more evidence, or a safer provider contract before merging. A passing test suite does not override the read-only and human-review boundaries.

## Commit and license expectations

Use concise commit subjects that describe the completed change. Keep formatting-only changes separate from behavioral changes when practical.

By submitting a contribution, you agree that it may be distributed under the repository's [Apache-2.0 license](LICENSE).

Production write paths, autonomous policy application, and calls to AI services with raw telemetry are outside the project scope.
