export type Outcome = 'success' | 'failure' | 'unknown';

export interface TraceEvent {
  id: string;
  origin?: string;
  projectId?: string;
  skill?: string;
  text: string;
  outcome: Outcome;
}

export interface Evidence {
  id: string;
  skill: string;
  action: string;
  outcome: Outcome;
  importedAt?: string;
}

export interface Pattern {
  id: string;
  skill: string;
  action: string;
  confidence: 'weak' | 'medium' | 'strong';
  evidence: string[];
  counterexamples: string[];
  updatedAt: string;
}

export interface Candidate {
  id: string;
  skill: string;
  content: string;
  sourceHash?: string;
  evidenceHash?: string;
  purposeHash?: string;
  contractHash?: string;
  fixtureHashes?: Record<string, string>;
  createdAt: string;
  status: 'draft' | 'evaluated' | 'rejected' | 'review';
}

export interface EvaluationRecord {
  id: string;
  candidateId: string;
  decision: 'reject' | 'review';
  baselineScore: number;
  candidateScore: number;
  failures: string[];
  promoted: false;
  canonicalSkillHash?: string;
  purposeHash?: string;
  contractHash?: string;
  fixtureHashes?: Record<string, string>;
  evidenceHash?: string;
  createdAt: string;
}
