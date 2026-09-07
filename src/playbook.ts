export interface EvaluationManifest {
  schemaVersion: 1;
  skill: string;
  sourceHash: string;
  baseline: string;
  minimumMargin: number;
  fixtures: Array<{ id: string; prompt: string; critical?: boolean }>;
}

export function validateManifest(value: unknown): EvaluationManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid evaluation manifest');
  const manifest = value as Partial<EvaluationManifest>;
  if (manifest.schemaVersion !== 1 || typeof manifest.skill !== 'string' || typeof manifest.sourceHash !== 'string' || typeof manifest.baseline !== 'string' || typeof manifest.minimumMargin !== 'number' || !Array.isArray(manifest.fixtures)) throw new Error('Invalid evaluation manifest');
  for (const fixture of manifest.fixtures) if (!fixture || typeof fixture.id !== 'string' || typeof fixture.prompt !== 'string') throw new Error('Invalid evaluation fixture');
  return manifest as EvaluationManifest;
}

export function assertCurrentSource(expected: string, actual: string): void { if (expected !== actual) throw new Error('Evaluation contract is stale: canonical skill hash changed'); }
