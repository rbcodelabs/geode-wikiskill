import type { Candidate, EvaluationRecord, Pattern } from "./model";

export function renderIndex(patterns: readonly Pattern[]): string {
  return `# Skill Evolution\n\nGenerated knowledge; review before use.\n\n${patterns.map((p) => `- [[${segment(p.skill)}/patterns/${segment(p.id)}|${inline(p.action)}]] — ${p.confidence}`).join("\n")}\n`;
}
export function renderPattern(pattern: Pattern): string {
  return `# ${inline(pattern.action)}\n\n- Skill: ${inline(pattern.skill)}\n- Confidence: ${pattern.confidence}\n- Evidence: ${pattern.evidence.join(", ") || "none"}\n- Counterexamples: ${pattern.counterexamples.join(", ") || "none"}\n- Updated: ${pattern.updatedAt}\n`;
}
export function renderEvolution(candidates: readonly Candidate[]): string {
  return `# Evolution Log\n\n${candidates.map((c) => `- ${c.createdAt} — ${c.id} — ${c.status}`).join("\n")}\n`;
}
export function renderImpact(records: readonly EvaluationRecord[]): string {
  return `# Impact History\n\n${records.map((r) => `- ${r.createdAt} — ${r.decision}: baseline ${r.baselineScore}, candidate ${r.candidateScore}`).join("\n")}\n`;
}
export function renderReview(
  candidate: Candidate,
  evaluation: EvaluationRecord,
): string {
  return `# Review: ${inline(candidate.id)}\n\nStatus: human review required\n\n## Candidate\n\n${candidate.content
    .split("\n")
    .map((line) => `    ${line}`)
    .join(
      "\n",
    )}\n\n## Rationale\n\n${inline(candidate.rationale ?? "Not supplied")}\n\n## Baseline-to-candidate diff\n\n### Baseline\n\n${indent(candidate.baselineContent ?? "Unavailable")}\n\n### Candidate\n\n${indent(candidate.content)}\n\n## Evaluation\n\n- Decision: ${evaluation.decision}\n- Baseline: ${evaluation.baselineScore}\n- Candidate: ${evaluation.candidateScore}\n- Fixture outcomes: ${inline(JSON.stringify(evaluation.fixtureOutcomes ?? {}))}\n- Usage: ${evaluation.usage?.inputTokens ?? 0} input / ${evaluation.usage?.outputTokens ?? 0} output / $${(evaluation.usage?.costUsd ?? 0).toFixed(4)}\n- Evidence hash: ${inline(candidate.evidenceHash ?? "pending")}\n- Contract hash: ${inline(candidate.contractHash ?? "pending")}\n- Automatic promotion: disabled\n`;
}
function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
function inline(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\[\]#*_`<>]/g, "\\$&")
    .trim();
}
function segment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^\.+$/, "item")
      .slice(0, 100) || "item"
  );
}
