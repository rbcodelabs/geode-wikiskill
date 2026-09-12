import type { ThreadsApiV1 } from './threads-contract';
import { hash } from './learning';
import { runNormalThread } from './normal-run';
import type { PluginState } from './state';
export interface Scenario {
    id: string;
    prompt: string;
    expected: string;
}
export function parseScenarios(text: string): Scenario[] {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || !value.length || value.length > 10)
        throw new Error('Supply 1–10 independent scenarios');
    const ids = new Set<string>();
    for (const s of value) {
        if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) || typeof s.prompt !== 'string' || !s.prompt || typeof s.expected !== 'string' || !s.expected || s.prompt.length > 8000 || s.expected.length > 8000)
            throw new Error('Invalid scenario: unique id, prompt and expected exact output are required');
        ids.add(s.id);
    }
    return value as Scenario[];
}
export async function evaluateScenarios(api: ThreadsApiV1, baseline: string, candidate: string, scenarios: Scenario[], setCancel: (cancel?: (() => Promise<void>)) => void = () => { }, storage: {
    jobs: PluginState['jobs'];
    persist: () => Promise<void>;
    candidateId?: string;
} = { jobs: [], persist: async () => { } }) {
    const fixtureOutcomes: Record<string, {
        baseline: boolean;
        candidate: boolean;
    }> = {};
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let cancelled = false;
    try {
        for (const scenario of scenarios) {
            fixtureOutcomes[scenario.id] = { baseline: false, candidate: false };
            for (const role of ['baseline', 'candidate'] as const) {
                if (cancelled)
                    throw new Error('Evaluation cancelled');
                const content = role === 'baseline' ? baseline : candidate;
                const key = hash(JSON.stringify({ mode: 'normal-v1', scenario, content, role, candidateId: storage.candidateId }));
                let job = storage.jobs.find(j => j.executionMode === 'normal-v1' && j.idempotencyKey === key);
                if (!job) {
                    job = { id: 'compare-' + key.slice(0, 24), type: 'evaluate', skill: storage.candidateId ?? 'comparison', status: 'queued', executionMode: 'normal-v1', idempotencyKey: key, input: { candidateId: storage.candidateId } };
                    storage.jobs.push(job);
                }
                const retryFailed = job.status === 'failed';
                job.status = 'running';
                await storage.persist();
                try {
                    const result = await runNormalThread(api, job, `WikiSkill comparison: ${scenario.id} / ${role}`, `Contextual skill comparison. Respond to the task using the supplied guidance. Analysis only: do not edit files, apply skills, install packages, or make external changes. This normal conversation inherits host context and permissions; it is not isolated.\n<guidance>\n${content}\n</guidance>\nTask: ${scenario.prompt}`, storage.persist, cancel => setCancel(cancel ? async () => { cancelled = true; job!.status = 'cancelled'; await storage.persist(); await cancel(); } : undefined), retryFailed);
                    if (cancelled)
                        throw new Error('Evaluation cancelled');
                    if (!result.finalMessage?.content)
                        throw new Error('No final reply');
                    fixtureOutcomes[scenario.id]![role] = result.finalMessage.content.trim() === scenario.expected.trim();
                    usage.inputTokens += result.usage?.inputTokens ?? 0;
                    usage.outputTokens += result.usage?.outputTokens ?? 0;
                    usage.costUsd += result.usage?.costUsd ?? 0;
                    job.status = 'complete';
                    job.outputHash = hash(result.finalMessage.content);
                    await storage.persist();
                }
                catch (error) {
                    job.status = cancelled ? 'cancelled' : 'failed';
                    job.error = `${error instanceof Error ? error.message : 'Comparison failed'} (Thread ${job.externalThreadId ?? 'not created'}; run ${job.externalRunId ?? 'not sent'})`;
                    await storage.persist();
                    throw new Error(job.error);
                }
            }
        }
    }
    finally {
        setCancel(undefined);
    }
    return { baselineScore: Object.values(fixtureOutcomes).filter(x => x.baseline).length / scenarios.length, candidateScore: Object.values(fixtureOutcomes).filter(x => x.candidate).length / scenarios.length, fixtureOutcomes, usage };
}
