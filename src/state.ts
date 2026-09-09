import type { Candidate, EvaluationRecord, Evidence, Pattern } from "./model";
import type { InstalledSkill } from "./learning";
export const STATE_SCHEMA_VERSION = 4;
export interface PluginState {
    skills: InstalledSkill[];
    vaultScan: {
        cursor?: string;
        hashes: Record<string, string>;
        outputRoots: string[];
    };
    schemaVersion: number;
    consentedProjects: string[];
    sourceCursor?: string;
    sourceRevision?: string;
    sourceCheckpoints: Record<string, {
        cursor?: string;
        revision: string;
        contentHash: string;
        byteLength: number;
        complete: boolean;
    }>;
    importProgress: {
        sourcePageCursor?: string;
        scannedSources: number;
        scannedBytes: number;
        importedEvents: number;
        redactions: number;
    };
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
            execution?: {
                harness: string;
                model: string;
                maxTurns: number;
            };
            maxCandidateTokens?: number;
        };
        externalThreadId?: string;
        externalRunId?: string;
        evidenceHash?: string;
        outputHash?: string;
        error?: string;
    }>;
    budget: {
        utcDay: string;
        usedTokens: number;
    };
    settings: {
        scenarioJson: string;
        skillRoots: string[];
        exclusions: string[];
        scheduledScan: boolean;
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
        skills: [],
        vaultScan: { hashes: {}, outputRoots: [] },
        consentedProjects: [],
        sourceCheckpoints: {},
        evidence: [],
        patterns: [],
        candidates: [],
        evaluations: [],
        jobs: [],
        importProgress: {
            scannedSources: 0,
            scannedBytes: 0,
            importedEvents: 0,
            redactions: 0,
        },
        budget: { utcDay: "", usedTokens: 0 },
        settings: {
            scenarioJson: '',
            skillRoots: [],
            exclusions: [],
            scheduledScan: false,
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
    if (!value || typeof value !== "object")
        return base;
    const raw = value as Partial<PluginState>;
    const source = raw.schemaVersion === 2 ? migrateV2(raw) : raw;
    return {
        ...base,
        skills: objectArray(source.skills).filter((s): s is Record<string, unknown> & InstalledSkill => ['id', 'name', 'path', 'hash', 'content'].every(k => typeof s[k] === 'string')),
        vaultScan: { cursor: typeof source.vaultScan?.cursor === 'string' ? source.vaultScan.cursor : undefined, hashes: Object.fromEntries(Object.entries(source.vaultScan?.hashes ?? {}).filter(([, v]) => typeof v === 'string')), outputRoots: Array.isArray(source.vaultScan?.outputRoots) ? source.vaultScan.outputRoots.filter(x => typeof x === 'string') : [] },
        consentedProjects: Array.isArray(source.consentedProjects)
            ? source.consentedProjects.filter((item): item is string => typeof item === "string")
            : [],
        sourceCursor: typeof source.sourceCursor === "string" ? source.sourceCursor : undefined,
        sourceRevision: typeof source.sourceRevision === "string"
            ? source.sourceRevision
            : undefined,
        sourceCheckpoints: sanitizeCheckpoints(source.sourceCheckpoints),
        importProgress: sanitizeImportProgress(source.importProgress),
        evidence: objectArray(source.evidence).filter(isEvidence),
        patterns: objectArray(source.patterns).filter(isPattern),
        candidates: objectArray(source.candidates).filter(isCandidate),
        evaluations: objectArray(source.evaluations).filter(isEvaluation),
        jobs: objectArray(source.jobs).filter(isJob),
        budget: isBudget(source.budget) ? source.budget : base.budget,
        settings: sanitizeSettings(source.settings, base.settings),
    };
}
function migrateV2(source: Partial<PluginState>): Partial<PluginState> {
    return {
        ...source,
        importProgress: source.importProgress ?? {
            scannedSources: 0,
            scannedBytes: 0,
            importedEvents: Array.isArray(source.evidence)
                ? source.evidence.length
                : 0,
            redactions: 0,
        },
        budget: source.budget ?? { utcDay: "", usedTokens: 0 },
    };
}
function objectArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        : [];
}
function sanitizeSettings(value: unknown, base: PluginState["settings"]): PluginState["settings"] {
    const v = value && typeof value === "object"
        ? (value as Partial<PluginState["settings"]>)
        : {};
    return {
        scenarioJson: typeof v.scenarioJson === 'string' ? v.scenarioJson : '',
        skillRoots: strings(v.skillRoots) ? v.skillRoots : [],
        exclusions: strings(v.exclusions) ? v.exclusions : [],
        scheduledScan: v.scheduledScan === true,
        outputRoot: typeof v.outputRoot === "string" &&
            v.outputRoot &&
            !v.outputRoot.startsWith("/") &&
            !v.outputRoot.split("/").includes("..")
            ? v.outputRoot
            : base.outputRoot,
        importLimit: positive(v.importLimit, base.importLimit),
        dailyTokenBudget: positive(v.dailyTokenBudget, base.dailyTokenBudget),
        retentionDays: positive(v.retentionDays, base.retentionDays),
        evaluationManifestPath: typeof v.evaluationManifestPath === "string"
            ? v.evaluationManifestPath
            : "",
        canonicalSkillPath: typeof v.canonicalSkillPath === "string" ? v.canonicalSkillPath : "",
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
    return (Array.isArray(value) && value.every((item) => typeof item === "string"));
}
function isEvidence(v: Record<string, unknown>): v is Record<string, unknown> & Evidence {
    return (typeof v.id === "string" &&
        typeof v.skill === "string" &&
        typeof v.action === "string" &&
        ["success", "failure", "unknown"].includes(String(v.outcome)));
}
function isPattern(v: Record<string, unknown>): v is Record<string, unknown> & Pattern {
    return (typeof v.id === "string" &&
        typeof v.skill === "string" &&
        typeof v.action === "string" &&
        ["weak", "medium", "strong"].includes(String(v.confidence)) &&
        strings(v.evidence) &&
        strings(v.counterexamples) &&
        typeof v.updatedAt === "string");
}
function isCandidate(v: Record<string, unknown>): v is Record<string, unknown> & Candidate {
    return (typeof v.id === "string" &&
        typeof v.skill === "string" &&
        typeof v.content === "string" &&
        typeof v.createdAt === "string" &&
        ["draft", "evaluated", "rejected", "review", "approved", "dismissed", "deferred"].includes(String(v.status)) &&
        optionalHash(v.sourceHash) &&
        optionalHash(v.evidenceHash) &&
        optionalHash(v.purposeHash) &&
        optionalHash(v.contractHash) &&
        optionalHashRecord(v.fixtureHashes));
}
function isEvaluation(v: Record<string, unknown>): v is Record<string, unknown> & EvaluationRecord {
    return (typeof v.id === "string" &&
        typeof v.candidateId === "string" &&
        ["reject", "review"].includes(String(v.decision)) &&
        typeof v.baselineScore === "number" &&
        Number.isFinite(v.baselineScore) &&
        typeof v.candidateScore === "number" &&
        Number.isFinite(v.candidateScore) &&
        strings(v.failures) &&
        v.promoted === false &&
        typeof v.createdAt === "string" &&
        optionalHash(v.canonicalSkillHash) &&
        optionalHash(v.purposeHash) &&
        optionalHash(v.contractHash) &&
        optionalHash(v.evidenceHash) &&
        optionalHash(v.baselineResultHash) &&
        optionalHash(v.candidateResultHash) &&
        optionalUsage(v.usage) &&
        optionalHashRecord(v.fixtureHashes) &&
        optionalOutcomes(v.fixtureOutcomes));
}
function isJob(v: Record<string, unknown>): v is Record<string, unknown> & PluginState["jobs"][number] {
    const input = v.input as Record<string, unknown> | undefined;
    return (typeof v.id === "string" &&
        ["maintainer-v1", "proposer-v1", "evaluate"].includes(String(v.type)) &&
        typeof v.skill === "string" &&
        ["queued", "running", "complete", "failed", "cancelled"].includes(String(v.status)) &&
        typeof v.idempotencyKey === "string" &&
        optionalHash(v.idempotencyKey) &&
        optionalHash(v.evidenceHash) &&
        optionalHash(v.outputHash) &&
        Boolean(input &&
            typeof input === "object" &&
            !Array.isArray(input) &&
            optionalString(input.evidence) &&
            optionalStrings(input.evidenceIds) &&
            optionalString(input.candidateId) &&
            optionalString(input.manifestPath) &&
            optionalString(input.canonicalSkillPath) &&
            optionalHash(input.candidateHash) &&
            optionalHash(input.sourceHash) &&
            optionalHash(input.contractHash) &&
            optionalHashRecord(input.fixtureHashes) &&
            optionalExecution(input.execution) &&
            (input.maxCandidateTokens === undefined ||
                (typeof input.maxCandidateTokens === "number" &&
                    Number.isSafeInteger(input.maxCandidateTokens) &&
                    input.maxCandidateTokens > 0))));
}
function optionalString(value: unknown): boolean {
    return value === undefined || typeof value === "string";
}
function optionalStrings(value: unknown): boolean {
    return value === undefined || strings(value);
}
function optionalHash(value: unknown): boolean {
    return (value === undefined ||
        (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)));
}
function optionalHashRecord(value: unknown): boolean {
    return (value === undefined ||
        Boolean(value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.values(value as Record<string, unknown>).every(optionalHash)));
}
function optionalExecution(value: unknown): boolean {
    if (value === undefined)
        return true;
    if (!value || typeof value !== "object")
        return false;
    const v = value as {
        harness?: unknown;
        model?: unknown;
        maxTurns?: unknown;
    };
    return (typeof v.harness === "string" &&
        typeof v.model === "string" &&
        typeof v.maxTurns === "number" &&
        Number.isSafeInteger(v.maxTurns) &&
        v.maxTurns > 0);
}
function optionalUsage(value: unknown): boolean {
    if (value === undefined)
        return true;
    if (!value || typeof value !== "object")
        return false;
    return ["inputTokens", "outputTokens", "costUsd"].every((key) => typeof (value as Record<string, unknown>)[key] === "number" &&
        Number.isFinite((value as Record<string, number>)[key]) &&
        (value as Record<string, number>)[key] >= 0);
}
function optionalOutcomes(value: unknown): boolean {
    return (value === undefined ||
        Boolean(value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.values(value as Record<string, unknown>).every((item) => Boolean(item &&
                typeof item === "object" &&
                typeof (item as {
                    baseline?: unknown;
                }).baseline === "boolean" &&
                typeof (item as {
                    candidate?: unknown;
                }).candidate === "boolean"))));
}
function isBudget(v: unknown): v is PluginState["budget"] {
    return Boolean(v &&
        typeof v === "object" &&
        typeof (v as PluginState["budget"]).utcDay === "string" &&
        typeof (v as PluginState["budget"]).usedTokens === "number" &&
        Number.isFinite((v as PluginState["budget"]).usedTokens) &&
        (v as PluginState["budget"]).usedTokens >= 0);
}
function sanitizeCheckpoints(value: unknown): PluginState["sourceCheckpoints"] {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [
        string,
        PluginState["sourceCheckpoints"][string]
    ] => {
        const v = entry[1];
        return Boolean(v &&
            typeof v === "object" &&
            typeof (v as {
                revision?: unknown;
            }).revision === "string" &&
            typeof (v as {
                contentHash?: unknown;
            }).contentHash === "string" &&
            typeof (v as {
                byteLength?: unknown;
            }).byteLength === "number" &&
            Number.isSafeInteger((v as {
                byteLength: number;
            }).byteLength) &&
            (v as {
                byteLength: number;
            }).byteLength >= 0 &&
            typeof (v as {
                complete?: unknown;
            }).complete === "boolean" &&
            ((v as {
                cursor?: unknown;
            }).cursor === undefined ||
                typeof (v as {
                    cursor?: unknown;
                }).cursor === "string"));
    }));
}
function sanitizeImportProgress(value: unknown): PluginState["importProgress"] {
    const v = value && typeof value === "object"
        ? (value as Partial<PluginState["importProgress"]>)
        : {};
    return {
        sourcePageCursor: typeof v.sourcePageCursor === "string" ? v.sourcePageCursor : undefined,
        scannedSources: finite(v.scannedSources),
        scannedBytes: finite(v.scannedBytes),
        importedEvents: finite(v.importedEvents),
        redactions: finite(v.redactions),
    };
}
function finite(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
}
