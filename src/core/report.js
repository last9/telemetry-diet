import { calculatePreview, generateLast9Policy, generateOtelConfig } from './policy.js';

function percent(value) {
  return `${Number(value || 0).toFixed(1).replace('.0', '')}%`;
}

export function generateMarkdownReport(summary, findings, selectedFindings, otelConfig, last9Policy, preview) {
  const lines = [
    '# Telemetry Diet report',
    '',
    '> AI explains. Analyzer proves. Human applies.',
    '',
    '## Scope',
    '',
    `- Source provider: **${summary.provider}**`,
    `- Service: **${summary.service || 'not specified'}**`,
    `- Environment/filter: **${summary.environment || 'not specified'}**`,
    `- Time window: **${summary.timeWindow.start}** to **${summary.timeWindow.end}**`,
    `- Records analyzed in selected window: **${summary.recordsAnalyzed ?? 'provider did not report'}**`,
    '',
    '## Existing provider policy context',
    '',
    ...(summary.existingPolicies?.length
      ? summary.existingPolicies.map((policy) => `- **${policy.name}** (${policy.type}): ${policy.summary}`)
      : ['- No existing policy context was returned by the provider.']),
    '',
    '## Top findings',
    '',
  ];
  findings.forEach((finding) => {
    lines.push(
      `### ${finding.title}`,
      '',
      `- Category: ${finding.category}`,
      `- Confidence: ${finding.confidence}`,
      `- Records affected in selected window: ${finding.affectedCount}`,
      `- Suggested action: ${finding.suggestedAction}`,
      `- Limitation: ${finding.warning}`,
      `- Redacted examples: ${(finding.examplesRedacted || []).map((example) => `\`${example}\``).join(', ') || 'none returned'}`,
      '',
    );
  });
  lines.push(
    '## Suggested policy and sample impact',
    '',
    `Enabled draft findings: ${selectedFindings.map((finding) => finding.title).join('; ') || 'none'}`,
    '',
    `- Before: ${preview.recordsAnalyzed} records`,
    `- Directional records affected: ${preview.recordsAffected}`,
    `- After preview: ${preview.recordsAfter} records`,
    `- Directional reduction: ${percent(preview.directionalReductionPercent)}`,
    `- Redacted attributes: ${preview.redactedFields.join(', ') || 'none'}`,
    `- Caveat: ${preview.caveat}`,
    '',
    '## OpenTelemetry Collector / OTTL draft',
    '',
    '```yaml',
    otelConfig,
    '```',
    '',
    '## Last9 draft policy JSON',
    '',
    '```json',
    JSON.stringify(last9Policy, null, 2),
    '```',
    '',
    '## Risks and caveats',
    '',
    ...((summary.limitations || []).map((limitation) =>
      `- Provider limitation: ${typeof limitation === 'string' ? limitation : limitation?.message || JSON.stringify(limitation)}`)),
    '- This is a deterministic sample/window analysis, not an exact savings estimate.',
    '- Generated rules are visible drafts and are never auto-applied.',
    '- Review routing, retention, incident-response, and compliance requirements before changing production.',
    '- Raw logs were not sent to an AI service by Telemetry Diet.',
  );
  return lines.join('\n');
}

export function generateArtifacts(summary, findings, selectedIds = null) {
  const selected = selectedIds
    ? findings.filter((finding) => selectedIds.includes(finding.id))
    : findings.filter((finding) => finding.defaultEnabled);
  const preview = calculatePreview(summary, selected);
  const otel = generateOtelConfig(selected);
  const last9 = generateLast9Policy(summary, selected);
  const markdown = generateMarkdownReport(summary, findings, selected, otel, last9, preview);
  return { selectedIds: selected.map(({ id }) => id), preview, markdown, otel, last9 };
}
