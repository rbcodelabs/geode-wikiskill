import { describe, it, expect, vi } from 'vitest';
import { JobQueue } from '../src/jobs';
import { ThreadsAdapter } from '../src/threads-adapter';
import { FakeThreadsApi } from './support/fake-threads';
import { evaluateScenarios } from '../src/scenarios';
import { runNormalThread } from '../src/normal-run';
const caps = ['threads.create', 'threads.send', 'threads.wait', 'threads.cancel', 'threads.open'];
function setup() { const api = new FakeThreadsApi({ capabilities: caps }); const adapter = new ThreadsAdapter(() => ({ api: { v1: api } }), new EventTarget()); adapter.start(); return { api, adapter }; }
describe('normal visible Agent Threads execution', () => {
    it('keeps separate job identities for distinct requests created in the same millisecond', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1);
        try {
            const { adapter } = setup();
            const jobs: import('../src/state').PluginState['jobs'] = [];
            const queue = new JobQueue(adapter, undefined, jobs);
            await queue.propose('export', 'first');
            await queue.propose('export', 'second');
            expect(new Set(jobs.map(j => j.id)).size).toBe(2);
        }
        finally {
            now.mockRestore();
        }
    });
    it('cancels the newly received run if cancellation races with send', async () => {
        const { api } = setup();
        let release: ((v: {
            runId: string;
        }) => void) | undefined;
        let cancel: (() => Promise<void>) | undefined;
        vi.spyOn(api.threads, 'send').mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const stop = vi.spyOn(api.threads, 'cancel');
        const wait = vi.spyOn(api.threads, 'wait');
        const work = runNormalThread(api, { id: 'j', idempotencyKey: 'k' }, 'title', 'prompt', async () => { }, c => { cancel = c; });
        await vi.waitFor(() => expect(release).toBeDefined());
        await cancel!();
        release!({ runId: 'late-run' });
        await expect(work).rejects.toThrow(/Cancelled/);
        expect(stop).toHaveBeenCalledWith('late-run');
        expect(wait).not.toHaveBeenCalled();
    });
    it('cancels during thread creation without sending a message', async () => {
        const { api } = setup();
        let release: ((v: {
            threadId: string;
        }) => void) | undefined;
        let cancel: (() => Promise<void>) | undefined;
        vi.spyOn(api.threads, 'create').mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const send = vi.spyOn(api.threads, 'send');
        const work = runNormalThread(api, { id: 'j', idempotencyKey: 'k' }, 'title', 'prompt', async () => { }, c => { cancel = c; });
        await cancel!();
        release!({ threadId: 'created' });
        await expect(work).rejects.toThrow(/Cancelled/);
        expect(send).not.toHaveBeenCalled();
    });
    it('sends a new attempt in the same conversation after malformed completed output', async () => {
        const { api, adapter } = setup();
        const jobs: import('../src/state').PluginState['jobs'] = [];
        const queue = new JobQueue(adapter, undefined, jobs);
        const wait = vi.spyOn(api.threads, 'wait');
        wait.mockResolvedValue({ status: 'completed', runId: 'r', threadId: 'thread-1', finalMessage: { content: 'invalid' } });
        await expect(queue.propose('export', 'evidence')).rejects.toThrow();
        wait.mockRestore();
        const send = vi.spyOn(api.threads, 'send');
        // The old run remains completed; outputRejected must request a new send, not replay it forever.
        expect((await queue.retry(jobs[0]!.id) as {
            content: string;
        }).content).toContain('candidate');
        expect(send).toHaveBeenCalledTimes(1);
        expect(jobs[0]?.attempt).toBe(1);
    });
    it('accepts one fenced JSON reply but rejects prose with an inspectable error', async () => {
        const { api, adapter } = setup();
        const wait = vi.spyOn(api.threads, 'wait');
        wait.mockResolvedValue({ status: 'completed', runId: 'r', threadId: 'thread-1', finalMessage: { content: '```json\n{"content":"revision"}\n```' } });
        expect((await new JobQueue(adapter).propose('export', 'one')).content).toBe('revision');
        wait.mockResolvedValue({ status: 'completed', runId: 'r', threadId: 'thread-1', finalMessage: { content: 'Here is a suggestion: {"content":"revision"}' } });
        await expect(new JobQueue(adapter).propose('export', 'two')).rejects.toThrow(/Thread/);
    });
    it('resumes a completed run after reload without resending it', async () => {
        const { api, adapter } = setup();
        const jobs: import('../src/state').PluginState['jobs'] = [];
        await new JobQueue(adapter, undefined, jobs).propose('export', 'evidence');
        jobs[0]!.status = 'running';
        const restored = JSON.parse(JSON.stringify(jobs));
        const queue = new JobQueue(adapter, undefined, restored);
        queue.reconcileInterrupted();
        const send = vi.spyOn(api.threads, 'send');
        await queue.retry(restored[0].id);
        expect(send).not.toHaveBeenCalled();
    });
    it('works without constrained capabilities, inherits host execution and keeps successful retries in one visible conversation', async () => {
        const { api, adapter } = setup();
        expect(adapter.status).toBe('full');
        const create = vi.spyOn(api.threads, 'create'), send = vi.spyOn(api.threads, 'send'), constrained = vi.spyOn(api.constrainedRuns, 'create');
        const jobs: import('../src/state').PluginState['jobs'] = [];
        const queue = new JobQueue(adapter, undefined, jobs);
        const candidate = await queue.propose('export', 'evidence');
        await queue.retry(jobs[0]!.id);
        expect(candidate.content).toContain('candidate');
        expect(create).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(constrained).not.toHaveBeenCalled();
        expect(create.mock.calls[0]?.[0]).toMatchObject({ ephemeral: false, background: false, origin: 'geode-wikiskill' });
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty('agentHarness');
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty('model');
        expect(jobs[0]?.externalThreadId).toBeTruthy();
        expect(jobs[0]?.externalRunId).toBeTruthy();
    });
    it('cancels timed-out messages and includes the inspectable thread reference in failure', async () => {
        const { api, adapter } = setup();
        vi.spyOn(api.threads, 'wait').mockResolvedValue({ status: 'timed_out', runId: 'r', threadId: 'thread-1' });
        const cancel = vi.spyOn(api.threads, 'cancel');
        const jobs: import('../src/state').PluginState['jobs'] = [];
        await expect(new JobQueue(adapter, undefined, jobs).propose('export', 'evidence')).rejects.toThrow(/thread-1/);
        expect(cancel).toHaveBeenCalled();
        expect(jobs[0]?.error).toContain('thread-1');
    });
    it('does not reuse migrated constrained run identities', async () => {
        const { api, adapter } = setup();
        const state = await import('../src/state');
        const jobs = state.defaultState().jobs;
        jobs.push({ id: 'old', type: 'proposer-v1', skill: 'export', status: 'failed', idempotencyKey: 'a'.repeat(64), externalRunId: 'legacy', input: { evidence: 'evidence' } });
        await expect(new JobQueue(adapter, undefined, jobs).retry('old')).rejects.toThrow(/legacy|new proposal/i);
    });
    it('compares baseline and candidate in separate visible normal threads', async () => {
        const { api } = setup();
        const create = vi.spyOn(api.threads, 'create'), constrained = vi.spyOn(api.constrainedRuns, 'create');
        const result = await evaluateScenarios(api, 'old', 'candidate improvement', [{ id: 'x', prompt: 'Return JSON', expected: '{"ok":true}' }]);
        expect(create).toHaveBeenCalledTimes(2);
        expect(constrained).not.toHaveBeenCalled();
        expect(result.candidateScore).toBe(1);
    });
});
