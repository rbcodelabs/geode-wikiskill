import type { ThreadsApiV1, RunResult } from './threads-contract';
export interface NormalRunState {
    id: string;
    idempotencyKey: string;
    externalThreadId?: string;
    externalRunId?: string;
    attempt?: number;
}
/** Ordinary visible conversations inherit host defaults and permissions. This is not a sandbox. */
export async function runNormalThread(api: ThreadsApiV1, state: NormalRunState, title: string, prompt: string, persist: () => Promise<void>, setCancellation: (cancel?: () => Promise<void>) => void, retryFailed = false, retryCompleted = false): Promise<Extract<RunResult, {
    status: 'completed';
}>> {
    let cancelled = false;
    const inspect = () => `Thread ${state.externalThreadId ?? 'not created'}; run ${state.externalRunId ?? 'not sent'}`;
    const cancel = async () => { cancelled = true; if (state.externalRunId)
        await api.threads.cancel(state.externalRunId); };
    try {
        setCancellation(cancel);
        if (!state.externalThreadId) {
            const created = await api.threads.create({ ownerPluginId: 'geode-wikiskill', origin: 'geode-wikiskill', externalJobId: state.id, idempotencyKey: `normal-v1:${state.idempotencyKey}:create`, title, ephemeral: false, background: false });
            state.externalThreadId = created.threadId;
            await persist();
        }
        if (state.externalRunId && retryFailed) {
            const previous = await api.threads.wait(state.externalRunId, { timeoutMs: 120000 });
            if (cancelled)
                throw new Error('Cancelled');
            if (previous.status === 'completed' && !retryCompleted)
                return previous;
            if (previous.status === 'timed_out') {
                await cancel();
                throw new Error('Still running; cancellation requested');
            }
            state.attempt = (state.attempt ?? 0) + 1;
            state.externalRunId = undefined;
            await persist();
        }
        if (cancelled)
            throw new Error('Cancelled before sending');
        if (!state.externalRunId) {
            const sent = await api.threads.send(state.externalThreadId, { ownerPluginId: 'geode-wikiskill', idempotencyKey: `normal-v1:${state.idempotencyKey}:send:${state.attempt ?? 0}`, prompt });
            state.externalRunId = sent.runId;
            await persist();
            if (cancelled) {
                await api.threads.cancel(sent.runId);
                throw new Error('Cancelled while sending');
            }
        }
        const result = await api.threads.wait(state.externalRunId, { timeoutMs: 120000 });
        if (result.status === 'timed_out') {
            await cancel();
            throw new Error('Timed out; cancellation requested');
        }
        if (cancelled)
            throw new Error('Cancelled');
        if (result.status !== 'completed')
            throw new Error(result.error.message);
        return result;
    }
    catch (error) {
        throw new Error(`${error instanceof Error ? error.message : 'Conversation failed'} (${inspect()})`);
    }
    finally {
        setCancellation(undefined);
    }
}
