# Contributing

Telemetry Diet is a local-first, read-only telemetry policy testbench. Contributions should preserve that trust boundary.

## Development

Requirements:

- Node.js 22 or newer
- npm

```bash
npm install
npm test
npm run check
npm start
```

Use the bundled sample MCP for development whenever possible. Do not commit provider credentials, OAuth tokens, raw production logs, or local `.telemetry-diet.json` files.

## Pull requests

- Keep provider adapters read-only.
- Prefer provider summaries and aggregates over raw records.
- Redact examples before they cross the provider boundary.
- Add focused tests for analyzer, normalization, and policy behavior.
- Describe limitations when a generated rule is provider-specific or best effort.

Production write paths, autonomous policy application, and raw-log AI calls are outside the launch scope.
