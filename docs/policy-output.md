# Policy outputs

Telemetry Diet generates reviewable drafts from the exact finding toggles enabled in the workbench. The deterministic analyzer, not an AI model, controls rule selection and before/after math.

## Preview math

`recordsAffected` is the sum of enabled drop findings, capped at `recordsAnalyzed`. When more than one drop category is enabled, the UI and report state that categories may overlap and the result is an upper bound unless the provider returned disjoint aggregates.

Redaction and normalization actions are not counted as dropped records. No output is described as exact cost savings.

## OpenTelemetry Collector and OTTL

The generated YAML can include:

- `filter/telemetry_diet` expressions for successful health paths and production DEBUG/TRACE records
- `transform/telemetry_diet` statements that delete risky attributes
- resource normalization into `service.name` and `deployment.environment.name`

The snippet is intentionally partial: add the processors to an existing logs pipeline after memory protection and before batching/export. OTTL attribute names, enum support, and processor versions differ across Collector distributions. Verify the draft with the exact Collector build and representative traffic. Maintainers can parser-check representative log and trace drafts with `npm run validate:artifacts -- --collector /path/to/otelcol-contrib`.

Fingerprint sampling and "remove from labels but keep in log body" are marked as unsupported portable semantics because they require backend- or pipeline-specific behavior.

## Last9 draft JSON

The export schema is [`telemetry-diet.last9-draft/v1`](../schemas/telemetry-diet.last9-draft.v1.schema.json) and always includes:

```json
{
  "draft": true,
  "apply": false
}
```

Each representable rule contains a name, rule type, filters, action, explanation, confidence, and source-finding reference. Health-check drops, severity drops, and risky-attribute deletion are exported. Naming normalization and label-only cardinality advice remain documented findings when there is no portable Last9 primitive.

The JSON is a draft interchange artifact, not a promise that every field/operator matches every Last9 integration version. Validate it against current Last9 primitives. Telemetry Diet does not auto-apply it.

## Markdown report

The report records provider, service, environment, exact selected time window, analyzed count, every finding and caveat, enabled policy, directional preview, and both generated configuration drafts. Examples are redacted before report generation.

Treat the report as review evidence, not an authorization to change production. Incident response, audit, retention, and compliance owners should review policy changes before rollout.
