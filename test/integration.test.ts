import { describe, expect, it } from "vitest";
import { ThreadsAdapter } from "../src/threads-adapter";
import { TraceImporter } from "../src/importer";
import { JobQueue } from "../src/jobs";
import { evaluateCandidate } from "../src/evaluation";
import { FakeThreadsApi } from "./support/fake-threads";

describe("vertical pilot", () => {
  it("discovers late, imports incrementally, excludes own traces, runs one isolated candidate evaluation, and never promotes", async () => {
    const events = new EventTarget();
    const plugins: Record<string, unknown> = {};
    const adapter = new ThreadsAdapter(() => plugins["claude-threads"], events);
    adapter.start();
    expect(adapter.status).toBe("offline");
    const api = new FakeThreadsApi();
    plugins["claude-threads"] = { api: { v1: api } };
    events.dispatchEvent(new Event("claude-threads:api-ready"));
    expect(adapter.status).toBe("full");
    const importer = new TraceImporter(adapter, new Set(["project-1"]), []);
    const first = await importer.importNext();
    expect(first.events.map((event) => event.id)).toEqual(["source-1:0"]);
    expect(first.cursor).toBe("3");
    expect((await importer.importNext()).events).toEqual([]);
    const queue = new JobQueue(adapter);
    const candidate = await queue.propose(
      "integration-routing",
      "Use the evidence",
    );
    expect(candidate.content).toContain("candidate");
    const fixture = {
      version: 1 as const,
      id: "route",
      prompt: { system: "Return JSON", user: "route" },
      execution: {
        mode: "constrained-run-v1" as const,
        maxTurns: 1 as const,
        maxTokens: 100,
        timeoutSeconds: 30,
        tools: [] as [],
        skills: [] as [],
        filesystem: "none" as const,
      },
      outputContract: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
      grader: "deep-equal" as const,
      expected: { ok: true },
    };
    const contract = {
      root: "/tmp",
      manifest: {
        version: 1 as const,
        skillId: "integration-routing",
        source: {
          path: "SKILL.md",
          hash: "source-hash",
          revision: "revision",
          purposePath: "PURPOSE.md",
          purposeHash: "purpose-hash",
        },
        budgets: { maxCandidateTokens: 1000, maxEvaluationSeconds: 60 },
        thresholds: {
          minimumAggregateImprovement: 0.1,
          requireNoCriticalRegression: true,
        },
        fixtures: [],
      },
      fixtures: [
        {
          fixture,
          hash: "fixture-hash",
          visibility: "public" as const,
          critical: true,
          weight: 1,
        },
      ],
      skillText: "base",
      purposeText: "purpose",
      baselineResults: undefined,
      manifestHash: "manifest-hash",
      contractHash: "contract-hash",
    };
    const result = await evaluateCandidate(
      adapter,
      contract,
      candidate.content,
    );
    expect(result.decision).toBe("review");
    expect(result.promoted).toBe(false);
  });

  it("fences stale API generations and remains browsable in read-only mode", () => {
    const api = new FakeThreadsApi({
      capabilities: ["traces.listSources", "traces.readChunk"],
    });
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    expect(adapter.status).toBe("read-only");
    api.generation = "new-generation";
    expect(() => adapter.requireApi()).toThrow(/generation/i);
  });

  it("does not advance a cursor when the trace source revision changes", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    api.sourceRevision = "new-hash";
    const importer = new TraceImporter(
      adapter,
      new Set(["project-1"]),
      [],
      "2",
      "old-hash",
    );
    await expect(importer.importNext()).rejects.toThrow(/revision/i);
    expect(importer.cursor).toBe("2");
  });
  it("propagates an invalid opaque event cursor without advancing it", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    const importer = new TraceImporter(
      adapter,
      new Set(["project-1"]),
      [],
      "invalid",
      "hash-1",
    );
    await expect(importer.importNext()).rejects.toThrow(/CURSOR_INVALID/);
    expect(importer.cursor).toBe("invalid");
  });

  it("prepares independent checkpoints for every eligible source without mutating caller state", async () => {
    const api = new FakeThreadsApi({ sourceCount: 2, sourcePageSize: 1 });
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    const importer = new TraceImporter(adapter, new Set(["project-1"]), []);
    const before = {};
    const batch = await importer.prepareBatch(before, 10);
    expect(batch.events.map((event) => event.id)).toEqual([
      "source-1:0",
      "source-2:0",
    ]);
    expect(Object.keys(batch.checkpoints)).toEqual(["source-1", "source-2"]);
    expect(batch.checkpoints["source-1"]).toMatchObject({
      revision: "hash-1",
      byteLength: 300,
    });
    expect(before).toEqual({});
  });
  it("resumes an append-only source under the same revision", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    const importer = new TraceImporter(adapter, new Set(["project-1"]), []);
    const first = await importer.prepareBatch({}, 10);
    api.appendAttributedEvent();
    const second = await importer.prepareBatch(first.checkpoints, 10);
    expect(second.events.map((event) => event.id)).toEqual(["source-1:3"]);
    expect(second.checkpoints["source-1"]!.byteLength).toBeGreaterThan(
      first.checkpoints["source-1"]!.byteLength,
    );
  });
  it("rejects shrink and same-length replacement without advancing checkpoints", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    const importer = new TraceImporter(adapter, new Set(["project-1"]), []);
    const first = await importer.prepareBatch({}, 10);
    api.setEventCount(2);
    await expect(importer.prepareBatch(first.checkpoints, 10)).rejects.toThrow(
      /shrank/,
    );
    api.setEventCount(3);
    api.contentSalt = "-changed";
    await expect(importer.prepareBatch(first.checkpoints, 10)).rejects.toThrow(
      /replaced/,
    );
    expect(first.checkpoints["source-1"]?.contentHash).toBe("content-1-3");
  });

  it("exposes the active authoring run to provider-backed cancellation", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    await new JobQueue(adapter, (_id, cancel) => {
      if (cancel) void cancel();
    }).propose("integration-routing", "evidence");
    expect(api.cancelledThreadRuns).toEqual(["author-run"]);
  });
  it("retries byte-identical stored authoring input under the stable job identity", async () => {
    const api = new FakeThreadsApi();
    const adapter = new ThreadsAdapter(
      () => ({ api: { v1: api } }),
      new EventTarget(),
    );
    adapter.start();
    const jobs: import("../src/state").PluginState["jobs"] = [];
    const queue = new JobQueue(adapter, () => undefined, jobs);
    await queue.propose("integration-routing", "original evidence");
    const id = jobs[0]!.id,
      key = jobs[0]!.idempotencyKey;
    await queue.propose(
      "integration-routing",
      "changed evidence must be ignored",
      id,
    );
    expect(jobs[0]!.input.evidence).toBe("original evidence");
    expect(jobs[0]!.idempotencyKey).toBe(key);
  });
});
