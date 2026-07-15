# Trace Intelligence

Trace Intelligence turns bounded trace aggregates into reviewable reduction candidates. It prioritizes measured exported bytes; span counts break ties or provide directional evidence when byte measurements are unavailable.

## Decision order

1. **Resource attributes:** suggest only attributes explicitly marked safe to trim and backed by measured bytes. Critical service, deployment, and telemetry SDK attributes are protected.
2. **Redundant instrumentation:** identify a specific instrumentation scope only when its declared retained peer exists. The wrapper and retained span may have different names and kinds. Error-bearing and business spans are excluded.
3. **Low-value leaf spans:** target exact `INTERNAL` leaf name and instrumentation-scope pairs. `SERVER`, `CLIENT`, error-bearing, and business spans are excluded.
4. **Residual head sampling:** present sampling last, without an exact byte-savings claim. The output warns that unsampled traces reduce APM visibility and that errors require a separately validated retention policy.

## Outputs

The Markdown report includes evidence, ranking, review requirements, and limitations. OTel Collector YAML and OTTL are marked `EXPORT-ONLY DRAFT`, set no apply instruction, and are never sent to a production endpoint.

Instrumentation disablement is library-specific, so the draft records exact candidates but does not invent a universal SDK configuration. Resource and leaf classifications come from the normalized input contract and must be checked against complete traces.

## Rollout boundary

Validate a small pilot first. Measure exported bytes before and after, then verify trace completeness, service boundaries, error visibility, and business-span coverage. Do not infer savings when byte evidence is missing, and do not scale a policy until the limited path is verified.
