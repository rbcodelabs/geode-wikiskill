import type { Candidate, EvaluationRecord, Evidence, Pattern } from './model';

export const STATE_SCHEMA_VERSION = 1;
export interface PluginState {
  schemaVersion: number;
  consentedProjects: string[];
  sourceCursor?: string;
  sourceRevision?: string;
  sourceCheckpoints: Record<string, { cursor?: string; revision: string; complete: boolean }>;
  evidence: Evidence[];
  patterns: Pattern[];
  candidates: Candidate[];
  evaluations: EvaluationRecord[];
  jobs: Array<{ id: string; type: string; status: 'queued' | 'running' | 'complete' | 'failed'; error?: string }>;
  settings: { outputRoot: string; importLimit: number; dailyTokenBudget: number; retentionDays: number; evaluationManifestPath: string; canonicalSkillPath: string };
}

export function defaultState(): PluginState {
  return { schemaVersion: STATE_SCHEMA_VERSION, consentedProjects: [], sourceCheckpoints: {}, evidence: [], patterns: [], candidates: [], evaluations: [], jobs: [], settings: { outputRoot: 'Agent Knowledge/Skill Evolution', importLimit: 100, dailyTokenBudget: 50000, retentionDays: 90, evaluationManifestPath: '', canonicalSkillPath: '' } };
}

export function migrateState(value: unknown): PluginState {
  const base = defaultState();
  if (!value || typeof value !== 'object') return base;
  const source = value as Partial<PluginState>;
  return {
    ...base,
    consentedProjects: Array.isArray(source.consentedProjects) ? source.consentedProjects.filter((item): item is string => typeof item === 'string') : [],
    sourceCursor: typeof source.sourceCursor === 'string' ? source.sourceCursor : undefined,
    sourceRevision: typeof source.sourceRevision === 'string' ? source.sourceRevision : undefined,
    sourceCheckpoints: source.sourceCheckpoints && typeof source.sourceCheckpoints === 'object' ? source.sourceCheckpoints : {},
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    patterns: Array.isArray(source.patterns) ? source.patterns : [],
    candidates: Array.isArray(source.candidates) ? source.candidates : [],
    evaluations: Array.isArray(source.evaluations) ? source.evaluations : [],
    jobs: Array.isArray(source.jobs) ? source.jobs : [],
    settings: { ...base.settings, ...(source.settings ?? {}) }
  };
}
