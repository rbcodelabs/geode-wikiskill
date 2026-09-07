import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export type JsonSchema = { type?: string; additionalProperties?: boolean; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: unknown[]; const?: unknown; minLength?: number; minItems?: number };
export interface Fixture { version: 1; id: string; prompt: { system: string; user: string }; execution: { mode: 'constrained-run-v1'; maxTurns: 1; maxTokens: number; timeoutSeconds: number; tools: []; skills: []; filesystem: 'none' }; outputContract: JsonSchema; grader: 'deep-equal' | 'exact-provider-map' | 'complete-capability-maps'; expected: unknown }
export interface EvaluationManifest { version: 1; skillId: string; source: { path: string; hash: string; revision: string; purposePath: string; purposeHash: string }; budgets: { maxCandidateTokens: number; maxEvaluationSeconds: number }; thresholds: { minimumAggregateImprovement: number; requireNoCriticalRegression: boolean }; fixtures: Array<{ id: string; path: string; hash: string; visibility: 'public' | 'holdout'; critical: boolean; weight: number }> }
export interface LoadedContract { root: string; manifest: EvaluationManifest; fixtures: Array<{ fixture: Fixture; hash: string; visibility: 'public' | 'holdout'; critical: boolean; weight: number }>; skillText: string; purposeText: string; contractHash: string }

export async function loadEvaluationContract(manifestPath: string): Promise<LoadedContract> {
  const root = dirname(resolve(manifestPath)); const manifestText = await readFile(resolve(manifestPath), 'utf8'); const manifest = JSON.parse(manifestText) as EvaluationManifest;
  if (manifest.version !== 1 || !manifest.skillId || !Array.isArray(manifest.fixtures) || !manifest.source) throw new Error('Invalid evaluation manifest');
  const repositoryRoot = resolve(root, '../..');
  const skillPath = contained(repositoryRoot, resolve(root, manifest.source.path)); const purposePath = contained(repositoryRoot, resolve(root, manifest.source.purposePath));
  const skillText = await readFile(skillPath, 'utf8'); const purposeText = await readFile(purposePath, 'utf8');
  assertHash('source skill', skillText, manifest.source.hash); assertHash('PURPOSE', purposeText, manifest.source.purposeHash);
  try { execFileSync('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', manifest.source.revision, 'HEAD'], { stdio: 'ignore' }); const pinned = execFileSync('git', ['-C', repositoryRoot, 'show', `${manifest.source.revision}:${relative(repositoryRoot, skillPath)}`], { encoding: 'utf8' }); assertHash('pinned source skill', pinned, manifest.source.hash); } catch { throw new Error('Source revision cannot be verified against the Playbook repository'); }
  if (!purposeText.includes(`Initial source revision: \`${manifest.source.revision}\``)) throw new Error('PURPOSE revision disagrees with manifest');
  const fixtures = [] as LoadedContract['fixtures'];
  for (const entry of manifest.fixtures) {
    const path = contained(root, resolve(root, entry.path)); const text = await readFile(path, 'utf8'); assertHash(`${entry.id} fixture`, text, entry.hash);
    const fixture = JSON.parse(text) as Fixture;
    if (fixture.id !== entry.id || fixture.version !== 1 || fixture.execution?.mode !== 'constrained-run-v1' || fixture.execution.maxTurns !== 1 || fixture.execution.tools.length || fixture.execution.skills.length || fixture.execution.filesystem !== 'none' || fixture.outputContract?.additionalProperties !== false) throw new Error(`${entry.id}: unsafe or invalid fixture`);
    if (fixture.execution.maxTokens > manifest.budgets.maxCandidateTokens || fixture.execution.timeoutSeconds > manifest.budgets.maxEvaluationSeconds) throw new Error(`${entry.id}: fixture exceeds contract budget`);
    fixtures.push({ fixture, hash: entry.hash, visibility: entry.visibility, critical: entry.critical, weight: entry.weight });
  }
  return { root, manifest, fixtures, skillText, purposeText, contractHash: sha256(manifestText) };
}

export function parseAndValidateOutput(text: string, schema: JsonSchema): unknown { let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('Evaluation output is not JSON'); } const errors = validateSchema(schema, value); if (errors.length) throw new Error(`Evaluation output violates closed schema: ${errors.join(', ')}`); return value; }
export function gradeFixture(fixture: Fixture, actual: unknown): boolean {
  if (fixture.grader === 'deep-equal' || fixture.grader === 'exact-provider-map') return stable(actual) === stable(fixture.expected);
  if (fixture.grader === 'complete-capability-maps') { const actualMap = object(actual); const expected = object(fixture.expected); return complete(object(actualMap.product), expected.product) && complete(object(actualMap.workflow), expected.workflow); }
  return false;
}
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function assertHash(name: string, text: string, expected: string): void { if (sha256(text) !== expected) throw new Error(`${name} hash is stale`); }
function contained(root: string, path: string): string { const rel = relative(root, path); if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('path escapes evaluation root'); return path; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function complete(value: Record<string, unknown>, keys: unknown): boolean { return Array.isArray(keys) && Object.keys(value).sort().join() === [...keys].sort().join() && Object.values(value).every(item => typeof item === 'string' && item.trim()); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`; return JSON.stringify(value); }
function validateSchema(schema: JsonSchema, value: unknown, path = '$'): string[] { const errors: string[] = []; if (schema.const !== undefined && stable(value) !== stable(schema.const)) errors.push(`${path}: const`); if (schema.enum && !schema.enum.some(v => stable(v) === stable(value))) errors.push(`${path}: enum`); if (schema.type === 'object') { if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: object`]; const map = value as Record<string, unknown>; for (const key of schema.required ?? []) if (!(key in map)) errors.push(`${path}.${key}: required`); if (schema.additionalProperties === false) for (const key of Object.keys(map)) if (!schema.properties?.[key]) errors.push(`${path}.${key}: additional`); for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in map) errors.push(...validateSchema(child, map[key], `${path}.${key}`)); } else if (schema.type === 'array') { if (!Array.isArray(value)) return [`${path}: array`]; if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: minItems`); if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(schema.items!, item, `${path}[${i}]`))); } else if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path}: string`); else if (schema.type === 'null' && value !== null) errors.push(`${path}: null`); if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) errors.push(`${path}: minLength`); return errors; }
