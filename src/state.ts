import type { Candidate, EvaluationRecord, Evidence, Pattern } from "./model";

export const STATE_SCHEMA_VERSION = 2;
export interface PluginState {
  schemaVersion: number;
  consentedProjects: string[];
  sourceCursor?: string;
  sourceRevision?: string;
  sourceCheckpoints: Record<
    string,
    {
      cursor?: string;
      revision: string;
      contentHash: string;
      byteLength: number;
      complete: boolean;
    }
  >;
  evidence: Evidence[];
  patterns: Pattern[];
  candidates: Candidate[];
  evaluations: EvaluationRecord[];
  jobs: Array<{
    id: string;
    type: "maintainer-v1" | "proposer-v1" | "evaluate";
    skill: string;
    status: "queued" | "running" | "complete" | "failed" | "cancelled";
    idempotencyKey: string;
    input: {
      evidence?: string;
      evidenceIds?: string[];
      candidateId?: string;
      manifestPath?: string;
      canonicalSkillPath?: string;
      candidateHash?: string;
      sourceHash?: string;
      contractHash?: string;
      fixtureHashes?: Record<string, string>;
      execution?: { harness: string; model: string; maxTurns: number };
    };
    externalThreadId?: string;
    externalRunId?: string;
    evidenceHash?: string;
    outputHash?: string;
    error?: string;
  }>;
  budget: { utcDay: string; usedTokens: number };
  settings: {
    outputRoot: string;
    importLimit: number;
    dailyTokenBudget: number;
    retentionDays: number;
    evaluationManifestPath: string;
    canonicalSkillPath: string;
    secretIds: string[];
  };
}

export function defaultState(): PluginState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    consentedProjects: [],
    sourceCheckpoints: {},
    evidence: [],
    patterns: [],
    candidates: [],
    evaluations: [],
    jobs: [],
    budget: { utcDay: "", usedTokens: 0 },
    settings: {
      outputRoot: "Agent Knowledge/Skill Evolution",
      importLimit: 100,
      dailyTokenBudget: 50000,
      retentionDays: 90,
      evaluationManifestPath: "",
      canonicalSkillPath: "",
      secretIds: [],
    },
  };
}

export function migrateState(value: unknown): PluginState {
  const base = defaultState();
  if (!value || typeof value !== "object") return base;
  const source = value as Partial<PluginState>;
  return {
    ...base,
    consentedProjects: Array.isArray(source.consentedProjects)
      ? source.consentedProjects.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    sourceCursor:
      typeof source.sourceCursor === "string" ? source.sourceCursor : undefined,
    sourceRevision:
      typeof source.sourceRevision === "string"
        ? source.sourceRevision
        : undefined,
    sourceCheckpoints: sanitizeCheckpoints(source.sourceCheckpoints),
    evidence: objectArray(source.evidence).filter(isEvidence),
    patterns: objectArray(source.patterns).filter(isPattern),
    candidates: objectArray(source.candidates).filter(isCandidate),
    evaluations: objectArray(source.evaluations).filter(isEvaluation),
    jobs: objectArray(source.jobs).filter(isJob),
    budget: isBudget(source.budget) ? source.budget : base.budget,
    settings: sanitizeSettings(source.settings, base.settings),
  };
}
function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}
function sanitizeSettings(
  value: unknown,
  base: PluginState["settings"],
): PluginState["settings"] {
  const v =
    value && typeof value === "object"
      ? (value as Partial<PluginState["settings"]>)
      : {};
  return {
    outputRoot:
      typeof v.outputRoot === "string" &&
      v.outputRoot &&
      !v.outputRoot.startsWith("/") &&
      !v.outputRoot.split("/").includes("..")
        ? v.outputRoot
        : base.outputRoot,
    importLimit: positive(v.importLimit, base.importLimit),
    dailyTokenBudget: positive(v.dailyTokenBudget, base.dailyTokenBudget),
    retentionDays: positive(v.retentionDays, base.retentionDays),
    evaluationManifestPath:
      typeof v.evaluationManifestPath === "string"
        ? v.evaluationManifestPath
        : "",
    canonicalSkillPath:
      typeof v.canonicalSkillPath === "string" ? v.canonicalSkillPath : "",
    secretIds: Array.isArray(v.secretIds)
      ? v.secretIds.filter((x): x is string => typeof x === "string")
      : [],
  };
}
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function isEvidence(
  v: Record<string, unknown>,
): v is Record<string, unknown> & Evidence {
  return (
    typeof v.id === "string" &&
    typeof v.skill === "string" &&
    typeof v.action === "string" &&
    ["success", "failure", "unknown"].includes(String(v.outcome))
  );
}
function isPattern(
  v: Record<string, unknown>,
): v is Record<string, unknown> & Pattern {
  return (
    typeof v.id === "string" &&
    typeof v.skill === "string" &&
    typeof v.action === "string" &&
    ["weak", "medium", "strong"].includes(String(v.confidence)) &&
    strings(v.evidence) &&
    strings(v.counterexamples) &&
    typeof v.updatedAt === "string"
  );
}
function isCandidate(
  v: Record<string, unknown>,
): v is Record<string, unknown> & Candidate {
  return (
    typeof v.id === "string" &&
    typeof v.skill === "string" &&
    typeof v.content === "string" &&
    typeof v.createdAt === "string" &&
    ["draft", "evaluated", "rejected", "review"].includes(String(v.status))
  );
}
function isEvaluation(
  v: Record<string, unknown>,
): v is Record<string, unknown> & EvaluationRecord {
  return (
    typeof v.id === "string" &&
    typeof v.candidateId === "string" &&
    ["reject", "review"].includes(String(v.decision)) &&
    typeof v.baselineScore === "number" &&
    typeof v.candidateScore === "number" &&
    strings(v.failures) &&
    v.promoted === false &&
    typeof v.createdAt === "string"
  );
}
function isJob(
  v: Record<string, unknown>,
): v is Record<string, unknown> & PluginState["jobs"][number] {
  const input = v.input as Record<string, unknown> | undefined;
  return (
    typeof v.id === "string" &&
    ["maintainer-v1", "proposer-v1", "evaluate"].includes(String(v.type)) &&
    typeof v.skill === "string" &&
    ["queued", "running", "complete", "failed", "cancelled"].includes(
      String(v.status),
    ) &&
    typeof v.idempotencyKey === "string" &&
    Boolean(
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      optionalString(input.evidence) &&
      optionalStrings(input.evidenceIds) &&
      optionalString(input.candidateId) &&
      optionalString(input.manifestPath) &&
      optionalString(input.canonicalSkillPath),
    )
  );
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
function optionalStrings(value: unknown): boolean {
  return value === undefined || strings(value);
}
function isBudget(v: unknown): v is PluginState["budget"] {
  return Boolean(
    v &&
    typeof v === "object" &&
    typeof (v as PluginState["budget"]).utcDay === "string" &&
    typeof (v as PluginState["budget"]).usedTokens === "number" &&
    (v as PluginState["budget"]).usedTokens >= 0,
  );
}
function sanitizeCheckpoints(value: unknown): PluginState["sourceCheckpoints"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, PluginState["sourceCheckpoints"][string]] => {
        const v = entry[1];
        return Boolean(
          v &&
          typeof v === "object" &&
          typeof (v as { revision?: unknown }).revision === "string" &&
          typeof (v as { contentHash?: unknown }).contentHash === "string" &&
          typeof (v as { byteLength?: unknown }).byteLength === "number" &&
          (v as { byteLength: number }).byteLength >= 0 &&
          typeof (v as { complete?: unknown }).complete === "boolean" &&
          ((v as { cursor?: unknown }).cursor === undefined ||
            typeof (v as { cursor?: unknown }).cursor === "string"),
        );
      },
    ),
  );
}
