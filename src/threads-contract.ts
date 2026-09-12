/** Pinned structural subset of Agent Threads public API v1. */
export interface PublicUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs?: number;
  readonly turns?: number;
}
export interface TraceSource {
  readonly sourceId: string;
  readonly threadId: string;
  readonly projectId?: string;
  readonly harness: "claude" | "codex";
  readonly revision: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly updatedAt: number;
}
export interface TraceSourcePage {
  readonly sources: readonly TraceSource[];
  readonly nextCursor?: string;
  readonly eof: boolean;
}
export interface ProviderTraceEvent {
  readonly index: number;
  readonly timestamp: string;
  readonly type: string;
  readonly invokedSkill?: string;
  readonly skillLoadOutcome?: "loaded";
  readonly skillRunOutcomes?: readonly {
    readonly invokedSkill: string;
    readonly runOutcome: "success" | "failure";
    readonly invocationIndex: number;
  }[];
  readonly data: unknown;
}
export interface TraceChunk {
  readonly sourceId: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly cursor?: string;
  readonly nextCursor: string;
  readonly eof: boolean;
  readonly events: readonly ProviderTraceEvent[];
}
export type RunResult =
  | {
      readonly status: "completed";
      readonly runId: string;
      readonly threadId: string;
      readonly finalMessage?: { readonly content: string };
      readonly usage?: PublicUsage;
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly threadId: string;
      readonly error: { readonly code: string; readonly message: string };
    }
  | {
      readonly status: "timed_out";
      readonly runId: string;
      readonly threadId: string;
    };
export type ConstrainedRunResult =
  | { readonly status: "running"; readonly runId: string }
  | {
      readonly status: "completed";
      readonly runId: string;
      readonly output: string;
      readonly model: string;
      readonly usage: PublicUsage;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly runId: string;
      readonly error: { readonly code: string; readonly message: string };
    };
export interface ThreadsApiV1 {
  readonly apiVersion: 1;
  readonly generation: string;
  readonly capabilities: readonly string[];
  readonly threads: {
    open(threadId:string):Promise<void>;
    create(input: {
      title?: string;
      origin?: string;
      externalJobId?: string;
      ephemeral?: boolean;
      background?: boolean;
      ownerPluginId?: string;
      idempotencyKey?: string;
    }): Promise<{ readonly threadId: string }>;
    send(
      threadId: string,
      input: {
        prompt: string;
        ownerPluginId?: string;
        idempotencyKey?: string;
      },
    ): Promise<{ readonly runId: string }>;
    wait(
      runId: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<RunResult>;
    cancel(runId: string): Promise<Exclude<RunResult, { status: "timed_out" }>>;
  };
  readonly traces: {
    listSources(options?: {
      readonly cursor?: string;
      readonly limit?: number;
    }): Promise<TraceSourcePage>;
    readChunk(
      sourceId: string,
      options?: { readonly cursor?: string; readonly limit?: number },
    ): Promise<TraceChunk>;
  };
  readonly constrainedRuns?: {
    create(input: {
      ownerPluginId: string;
      idempotencyKey: string;
      harness: "claude";
      model: string;
      systemInstructions: string;
      prompt: string;
      maxTurns: 1;
      maxBudgetUsd: number;
      timeoutMs: number;
    }): Promise<{ readonly runId: string }>;
    wait(
      runId: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<ConstrainedRunResult>;
    cancel(runId: string): Promise<ConstrainedRunResult>;
  };
}
export interface ThreadsPluginShape {
  api?: { v1?: ThreadsApiV1 };
}
