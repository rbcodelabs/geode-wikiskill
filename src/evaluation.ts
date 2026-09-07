import { ThreadsAdapter } from './threads-adapter';

interface Score { score: number; failures: string[] }
export function gradeEvaluation(input: { baseline: Score; candidate: Score; policy: { minimumMargin: number; criticalFixtures: string[] } }): { decision: 'reject' | 'review'; reason: string } {
  const criticalRegression = input.candidate.failures.some(id => input.policy.criticalFixtures.includes(id) && !input.baseline.failures.includes(id));
  if (criticalRegression) return { decision: 'reject', reason: 'critical fixture regression' };
  if (input.candidate.score - input.baseline.score < input.policy.minimumMargin) return { decision: 'reject', reason: 'insufficient improvement' };
  return { decision: 'review', reason: 'candidate improved without critical regressions' };
}

export async function evaluateCandidate(adapter: ThreadsAdapter, input: { skill: string; baseline: string; candidate: string; fixtures: Array<{ id: string; prompt: string; critical?: boolean }>; minimumMargin: number }, setCancellation: (cancel?: () => Promise<void>) => void = () => undefined) {
  const api = adapter.requireApi();
  const run = async (content: string, role: string): Promise<Score> => {
    let passed = 0; const failures: string[] = [];
    for (const fixture of input.fixtures) {
      const created = await api.constrainedRuns.create({ ownerPluginId: 'geode-wikiskill', idempotencyKey: `${input.skill}-${role}-${fixture.id}`, harness: 'claude', model: 'claude-sonnet-4-5', systemInstructions: content, prompt: fixture.prompt, maxTurns: 1, maxBudgetUsd: 0.25, timeoutMs: 60000 });
      setCancellation(async () => { await api.constrainedRuns.cancel(created.runId); });
      const result = await api.constrainedRuns.wait(created.runId, { timeoutMs: 60000 });
      setCancellation(undefined);
      if (result.status !== 'completed') throw new Error(result.status === 'running' ? 'Constrained evaluation timed out' : result.error.message);
      if (/\bPASS\b/.test(result.output)) passed += 1; else failures.push(fixture.id);
    }
    return { score: input.fixtures.length ? passed / input.fixtures.length : 0, failures };
  };
  try {
    const baseline = await run(input.baseline, 'baseline');
    const candidate = await run(input.candidate, 'candidate');
    const graded = gradeEvaluation({ baseline, candidate, policy: { minimumMargin: input.minimumMargin, criticalFixtures: input.fixtures.filter(item => item.critical).map(item => item.id) } });
    return { ...graded, baseline, candidate, promoted: false as const };
  } finally { setCancellation(undefined); }
}
