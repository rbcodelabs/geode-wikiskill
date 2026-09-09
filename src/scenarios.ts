import type { ThreadsApiV1 } from './threads-contract';
import { hash } from './learning';
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
export async function evaluateScenarios(api: ThreadsApiV1, baseline: string, candidate: string, scenarios: Scenario[], setCancel: (cancel?: (() => Promise<void>)) => void = () => { }) {
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
                const run = await api.constrainedRuns.create({ ownerPluginId: 'geode-wikiskill', idempotencyKey: hash(JSON.stringify({ scenario, content, role })), harness: 'claude', model: 'claude-sonnet-4-5', maxTurns: 1, maxBudgetUsd: 0.10, timeoutMs: 120000, systemInstructions: `Follow this skill guidance for the task. No tools are available.\n${content}`, prompt: scenario.prompt });
                setCancel(async () => { cancelled = true; await api.constrainedRuns.cancel(run.runId); });
                const result = await api.constrainedRuns.wait(run.runId, { timeoutMs: 120000 });
                if (result.status === 'running')
                    await api.constrainedRuns.cancel(run.runId);
                if (cancelled)
                    throw new Error('Evaluation cancelled');
                if (result.status !== 'completed')
                    throw new Error(result.status === 'running' ? 'Evaluation timed out' : result.error.message);
                fixtureOutcomes[scenario.id]![role] = result.output.trim() === scenario.expected.trim();
                usage.inputTokens += result.usage.inputTokens;
                usage.outputTokens += result.usage.outputTokens;
                usage.costUsd += result.usage.costUsd;
            }
        }
    }
    finally {
        setCancel(undefined);
    }
    return { baselineScore: Object.values(fixtureOutcomes).filter(x => x.baseline).length / scenarios.length, candidateScore: Object.values(fixtureOutcomes).filter(x => x.candidate).length / scenarios.length, fixtureOutcomes, usage };
}
