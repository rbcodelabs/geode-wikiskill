import type { ConstrainedRunResult, RunResult, ThreadsApiV1, TraceChunk } from '../../src/threads-contract';
export class FakeThreadsApi implements ThreadsApiV1 {
  readonly apiVersion = 1 as const; generation = 'generation-1'; sourceRevision = 'hash-1'; readonly capabilities: readonly string[];
  private constrained = new Map<string, ConstrainedRunResult>(); private threadRuns = new Map<string, RunResult>();
  cancelledThreadRuns: string[] = [];
  private sourceCount: number;
  constructor(options: { capabilities?: string[]; sourceCount?: number } = {}) { this.capabilities = options.capabilities ?? ['traces.listSources', 'traces.readChunk', 'threads.create', 'threads.send', 'threads.wait', 'constrainedRuns.create', 'constrainedRuns.wait']; this.sourceCount = options.sourceCount ?? 1; }
  traces = {
    listSources: async () => Array.from({ length: this.sourceCount }, (_, index) => ({ sourceId: `source-${index + 1}`, threadId: `source-${index + 1}`, projectId: 'project-1', harness: 'claude' as const, revision: this.sourceRevision, updatedAt: index + 1 })),
    readChunk: async (sourceId: string, options?: { cursor?: string }): Promise<TraceChunk> => ({ sourceId, revision: this.sourceRevision, cursor: options?.cursor, nextCursor: options?.cursor ? undefined : '2', eof: Boolean(options?.cursor), events: options?.cursor ? [] : [
      { index: 0, timestamp: 'now', type: 'result', data: { id: 'external-1', origin: 'human', skill: 'integration-routing', text: 'resolve independently', outcome: 'success' } },
      { index: 1, timestamp: 'now', type: 'result', data: { id: 'own-1', origin: 'geode-wikiskill', skill: 'integration-routing', text: 'candidate', outcome: 'success' } }
    ] })
  };
  threads = {
    create: async () => ({ threadId: 'thread-1' }),
    send: async () => { const runId = 'author-run'; this.threadRuns.set(runId, { status: 'completed', runId, threadId: 'thread-1', finalMessage: { content: '{"content":"candidate improvement"}' } }); return { runId }; },
    wait: async (runId: string) => this.threadRuns.get(runId)!,
    cancel: async (runId: string) => { this.cancelledThreadRuns.push(runId); return this.threadRuns.get(runId) as Exclude<RunResult, { status: 'timed_out' }>; }
  };
  constrainedRuns = {
    create: async ({ idempotencyKey, systemInstructions }: { idempotencyKey: string; systemInstructions: string }) => { const runId = idempotencyKey; this.constrained.set(runId, { status: 'completed', runId, output: systemInstructions.includes('candidate') ? 'PASS' : 'FAIL', model: 'test', usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 } }); return { runId }; },
    wait: async (runId: string) => this.constrained.get(runId)!,
    cancel: async (runId: string) => this.constrained.get(runId)!
  };
}
