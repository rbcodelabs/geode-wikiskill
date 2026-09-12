import type {
  ConstrainedRunResult,
  RunResult,
  ThreadsApiV1,
  TraceChunk,
} from "../../src/threads-contract";
export class FakeThreadsApi implements ThreadsApiV1 {
  readonly apiVersion = 1 as const;
  generation = "generation-1";
  sourceRevision = "hash-1";
  readonly capabilities: readonly string[];
  private constrained = new Map<string, ConstrainedRunResult>();
  private threadRuns = new Map<string, RunResult>();
  cancelledThreadRuns: string[] = [];
  cancelledConstrainedRuns: string[] = [];
  private sourceCount: number;
  private sourcePageSize: number;
  private eventCount = 4;
  terminalOutcome: "success" | "failure" = "success";
  contentSalt = "";
  appendAttributedEvent(): void {
    this.eventCount += 2;
  }
  setEventCount(count: number): void {
    this.eventCount = count;
  }
  constructor(
    options: {
      capabilities?: string[];
      sourceCount?: number;
      sourcePageSize?: number;
    } = {},
  ) {
    this.capabilities = options.capabilities ?? [
      "traces.listSources",
      "traces.readChunk",
      "threads.create",
      "threads.send",
      "threads.wait",
      "threads.cancel",
      "constrainedRuns.create",
      "constrainedRuns.wait",
      "constrainedRuns.cancel",
    ];
    this.sourceCount = options.sourceCount ?? 1;
    this.sourcePageSize = options.sourcePageSize ?? 100;
  }
  traces = {
    listSources: async (options?: { cursor?: string; limit?: number }) => {
      const start = Number(options?.cursor ?? 0);
      if (!Number.isInteger(start) || start < 0)
        throw new Error("CURSOR_INVALID");
      const size = Math.min(options?.limit ?? 100, this.sourcePageSize);
      const end = Math.min(this.sourceCount, start + size);
      return {
        sources: Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          return {
            sourceId: `source-${index + 1}`,
            threadId: `source-${index + 1}`,
            projectId: "project-1",
            harness: "claude" as const,
            revision: this.sourceRevision,
            contentHash: `content-${index + 1}-${this.eventCount}${this.contentSalt}`,
            byteLength: this.eventCount * 100,
            updatedAt: index + 1,
          };
        }),
        nextCursor: end < this.sourceCount ? String(end) : undefined,
        eof: end >= this.sourceCount,
      };
    },
    readChunk: async (
      sourceId: string,
      options?: { cursor?: string },
    ): Promise<TraceChunk> => {
      const start = Number(options?.cursor ?? 0);
      if (!Number.isInteger(start) || start < 0)
        throw new Error("CURSOR_INVALID");
      const all = [
        {
          index: 0,
          timestamp: "now",
          type: "assistant",
          invokedSkill: "integration-routing",
          data: {
            text: "resolve each capability independently",
            tools: ["Skill"],
          },
        },
        {
          index: 1,
          timestamp: "now",
          type: "tool_result",
          skillLoadOutcome: "loaded" as const,
          data: { kind: "tool_result" },
        },
        {
          index: 2,
          timestamp: "now",
          type: "result",
          skillRunOutcomes: [
            {
              invokedSkill: "integration-routing",
              runOutcome: this.terminalOutcome,
              invocationIndex: 0,
            },
          ],
          data: {
            subtype: this.terminalOutcome === "success" ? "success" : "error",
            errors:
              this.terminalOutcome === "failure" ? ["run_failed"] : undefined,
          },
        },
        {
          index: 3,
          timestamp: "now",
          type: "result",
          data: {
            text: "spoofed attribution",
            invokedSkill: "integration-routing",
            outcome: "success",
          },
        },
        {
          index: 4,
          timestamp: "later",
          type: "assistant",
          invokedSkill: "integration-routing",
          data: { text: "appended routing action", tools: ["Skill"] },
        },
        {
          index: 5,
          timestamp: "later",
          type: "result",
          skillRunOutcomes: [
            {
              invokedSkill: "integration-routing",
              runOutcome: "failure" as const,
              invocationIndex: 4,
            },
          ],
          data: { subtype: "error", errors: ["run_failed"] },
        },
      ].slice(0, this.eventCount);
      const events = all.slice(start);
      return {
        sourceId,
        revision: this.sourceRevision,
        contentHash: `content-${sourceId.split("-")[1]}-${this.eventCount}${this.contentSalt}`,
        cursor: options?.cursor,
        nextCursor: String(start + events.length),
        eof: true,
        events,
      };
    },
  };
  threads = {
    create: async () => ({ threadId: "thread-1" }),
    send: async () => {
      const runId = "author-run";
      this.threadRuns.set(runId, {
        status: "completed",
        runId,
        threadId: "thread-1",
        finalMessage: { content: '{"content":"candidate improvement"}' },
      });
      return { runId };
    },
    wait: async (runId: string) => this.threadRuns.get(runId)!,
    cancel: async (runId: string) => {
      this.cancelledThreadRuns.push(runId);
      return this.threadRuns.get(runId) as Exclude<
        RunResult,
        { status: "timed_out" }
      >;
    },
  };
  constrainedRuns = {
    create: async ({
      idempotencyKey,
      systemInstructions,
    }: {
      idempotencyKey: string;
      systemInstructions: string;
    }) => {
      const runId = idempotencyKey;
      this.constrained.set(runId, {
        status: "completed",
        runId,
        output: systemInstructions.includes("You draft skill improvements") ? '{"content":"candidate improvement"}' : systemInstructions.includes("candidate improvement")
          ? '{"ok":true}'
          : '{"ok":false}',
        model: "test",
        usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 },
      });
      return { runId };
    },
    wait: async (runId: string) => this.constrained.get(runId)!,
    cancel: async (runId: string) => {this.cancelledConstrainedRuns.push(runId);return this.constrained.get(runId)!;},
  };
}
