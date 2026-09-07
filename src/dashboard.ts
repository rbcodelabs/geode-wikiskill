import type { Candidate, EvaluationRecord, Pattern } from "./model";
import type { DependencyStatus } from "./threads-adapter";

export interface DashboardModel {
  status: DependencyStatus;
  imported: number;
  redactions: number;
  patterns: Pattern[];
  candidates: Candidate[];
  evaluations: EvaluationRecord[];
  jobs?: Array<{ id: string; status: string; type: string }>;
  importProgress?: {
    sourcePageCursor?: string;
    scannedSources: number;
    scannedBytes: number;
    importedEvents: number;
    redactions: number;
  };
}
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function renderDashboard(model: DashboardModel): string {
  const status =
    model.status === "full"
      ? "Connected"
      : model.status === "read-only"
        ? "Read only"
        : "Offline";
  const cards = [
    ["Dependency", `${status} · Agent Threads`],
    [
      "Import",
      `${model.imported} evidence events · ${model.redactions} redactions<br>Scanned: ${model.importProgress?.scannedSources ?? 0} sources / ${model.importProgress?.scannedBytes ?? 0} bytes<br>Continuation: ${escape(model.importProgress?.sourcePageCursor ?? "start")}`,
    ],
    [
      "Patterns",
      model.patterns.length
        ? model.patterns
            .map((p) => `${escape(p.action)} (${p.confidence})`)
            .join("<br>")
        : "No compiled patterns",
    ],
    [
      "Candidates",
      model.candidates.length
        ? model.candidates
            .map(
              (c) =>
                `${escape(c.id)} — ${c.status}<br><code>${escape(c.content)}</code>${c.rationale ? `<br>Rationale: ${escape(c.rationale)}` : ""}<br>Provenance: ${escape(c.evidenceHash ?? "pending")}<br>Diff: <del>${escape(c.baselineContent ?? "")}</del><ins>${escape(c.content)}</ins>`,
            )
            .join("<hr>")
        : "No candidates",
    ],
    [
      "Evaluations",
      model.evaluations.length
        ? model.evaluations
            .map(
              (e) =>
                `${escape(e.candidateId)} — ${e.decision} (${e.baselineScore.toFixed(2)} → ${e.candidateScore.toFixed(2)})<br>Fixtures: ${escape(JSON.stringify(e.fixtureOutcomes ?? {}))}<br>Usage: ${e.usage?.inputTokens ?? 0} in / ${e.usage?.outputTokens ?? 0} out / $${(e.usage?.costUsd ?? 0).toFixed(4)}<br>Contract: ${escape(e.contractHash ?? "pending")}`,
            )
            .join("<hr>")
        : "No evaluations",
    ],
    [
      "Jobs",
      model.jobs?.length
        ? model.jobs
            .map(
              (j) =>
                `${escape(j.id)} — ${escape(j.type)} — ${escape(j.status)}`,
            )
            .join("<br>")
        : "No jobs",
    ],
    [
      "Review",
      model.candidates
        .filter((c) => c.status === "review")
        .map((c) => `${escape(c.id)} — human review required`)
        .join("<br>") || "Nothing awaiting review",
    ],
  ];
  const actions = [
    "Import evidence",
    "Compile patterns",
    "Propose candidate",
    "Evaluate",
    "Cancel",
    "Retry",
    "Export review packets",
  ];
  return `<div class="wikiskill-shell"><header><p class="eyebrow">AGENT KNOWLEDGE</p><h1>WikiSkill Evolution</h1><p>Evidence becomes reviewable skill improvements—never automatic changes.</p><span class="status status-${model.status}">${status}</span></header><nav>${cards.map(([title]) => `<button type="button" data-section="${title.toLowerCase()}">${title}</button>`).join("")}</nav><div class="wikiskill-actions">${actions.map((action) => `<button type="button" data-action="${action.toLowerCase().replace(/ /g, "-")}">${action}</button>`).join("")}</div><main>${cards.map(([title, body]) => `<section id="wikiskill-${title.toLowerCase()}"><h2>${title}</h2><p>${body}</p></section>`).join("")}</main></div>`;
}
export interface DashboardActionTarget {
  importEvidence(): Promise<void>;
  compile(): Promise<void>;
  propose(): Promise<void>;
  evaluateLatest(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  exportReviewPackets(): Promise<void>;
}
export async function dispatchDashboardAction(
  target: DashboardActionTarget,
  action: string,
): Promise<void> {
  const routes: Record<string, () => Promise<void>> = {
    "import-evidence": () => target.importEvidence(),
    "compile-patterns": () => target.compile(),
    "propose-candidate": () => target.propose(),
    evaluate: () => target.evaluateLatest(),
    cancel: () => target.cancel(),
    retry: () => target.retry(),
    "export-review-packets": () => target.exportReviewPackets(),
  };
  await routes[action]?.();
}
export function wireDashboardControls(
  root: HTMLElement,
  action: (name: string) => void,
): void {
  for (const button of Array.from(
    root.querySelectorAll<HTMLElement>("[data-action]"),
  ))
    button.addEventListener("click", () => action(button.dataset.action ?? ""));
  for (const button of Array.from(
    root.querySelectorAll<HTMLElement>("[data-section]"),
  ))
    button.addEventListener("click", () =>
      root
        .querySelector(`#wikiskill-${button.dataset.section}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
}
