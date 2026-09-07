import { describe, expect, it } from "vitest";
import { compilePatterns } from "../src/compiler";
import { eligibleTrace, redactTrace } from "../src/privacy";
import { gradeEvaluation } from "../src/evaluation";
import { defaultState, migrateState } from "../src/state";
import { gradeFixture, parseAndValidateOutput } from "../src/playbook";
import { BudgetScheduler } from "../src/scheduler";
import { renderDashboard } from "../src/dashboard";

describe("privacy boundary", () => {
  it("excludes own-origin and non-consented traces", () => {
    expect(
      eligibleTrace(
        { origin: "geode-wikiskill", projectId: "p" },
        new Set(["p"]),
      ),
    ).toBe(false);
    expect(
      eligibleTrace({ origin: "human", projectId: "x" }, new Set(["p"])),
    ).toBe(false);
  });
  it("redacts secrets and common PII twice without retaining original text", () => {
    const value = redactTrace(
      "email me at rick@example.com key=sk-abc123 token ghp_12345678901234567890",
      ["sk-abc123"],
    );
    expect(value.text).not.toContain("rick@example.com");
    expect(value.text).not.toContain("sk-abc123");
    expect(value.text).not.toContain("ghp_");
    expect(value.redactions).toBeGreaterThanOrEqual(3);
  });
});

describe("compiler", () => {
  it("scores repeated successful evidence and preserves failed counterevidence", () => {
    const patterns = compilePatterns([
      {
        id: "1",
        skill: "integration-routing",
        action: "resolve each capability independently",
        outcome: "success",
      },
      {
        id: "2",
        skill: "integration-routing",
        action: "resolve each capability independently",
        outcome: "success",
      },
      {
        id: "3",
        skill: "integration-routing",
        action: "use one provider for everything",
        outcome: "failure",
      },
    ]);
    expect(patterns[0]?.confidence).toBe("medium");
    expect(
      patterns.some((pattern) => pattern.counterexamples.length === 1),
    ).toBe(true);
  });
});

describe("governance", () => {
  it("rejects no-op and harmful candidates and accepts a beneficial candidate", () => {
    const policy = { minimumMargin: 0.1, criticalFixtures: ["safety"] };
    expect(
      gradeEvaluation({
        baseline: { score: 0.8, failures: [], passes: { safety: true } },
        candidate: { score: 0.8, failures: [], passes: { safety: true } },
        policy,
      }).decision,
    ).toBe("reject");
    expect(
      gradeEvaluation({
        baseline: { score: 0.8, failures: [], passes: { safety: true } },
        candidate: {
          score: 0.95,
          failures: ["safety"],
          passes: { safety: false },
        },
        policy,
      }).decision,
    ).toBe("reject");
    expect(
      gradeEvaluation({
        baseline: { score: 0.8, failures: [], passes: { safety: true } },
        candidate: { score: 0.95, failures: [], passes: { safety: true } },
        policy,
      }).decision,
    ).toBe("review");
  });
});

describe("state", () => {
  it("migrates unknown old state to current schema without activating candidates", () => {
    const state = migrateState({ schemaVersion: 0, consentedProjects: ["p"] });
    expect(state.schemaVersion).toBe(defaultState().schemaVersion);
    expect(state.consentedProjects).toEqual(["p"]);
    expect(state.candidates).toEqual([]);
  });
});

describe("playbook and scheduling boundaries", () => {
  it("rejects non-JSON and additional output properties, then grades valid output locally", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { const: "blocked" } },
    };
    expect(() => parseAndValidateOutput("PASS", schema)).toThrow(/JSON/);
    expect(() =>
      parseAndValidateOutput('{"status":"blocked","extra":true}', schema),
    ).toThrow(/closed schema/);
    const fixture = {
      version: 1 as const,
      id: "f",
      prompt: { system: "s", user: "u" },
      execution: {
        mode: "constrained-run-v1" as const,
        maxTurns: 1 as const,
        maxTokens: 10,
        timeoutSeconds: 10,
        tools: [] as [],
        skills: [] as [],
        filesystem: "none" as const,
      },
      outputContract: schema,
      grader: "deep-equal" as const,
      expected: { status: "blocked" },
    };
    expect(gradeFixture(fixture, { status: "blocked" })).toBe(true);
  });
  it("skips empty work and enforces a daily budget", async () => {
    const scheduler = new BudgetScheduler(10);
    expect(
      (await scheduler.run("skill", 5, async () => undefined)).status,
    ).toBe("skipped");
    expect((await scheduler.run("skill", 11, async () => "never")).status).toBe(
      "skipped",
    );
  });
  it("resets the scheduler budget on the next UTC day", async () => {
    let now = new Date("2026-09-07T12:00:00Z");
    const scheduler = new BudgetScheduler(
      5,
      { utcDay: "", usedTokens: 0 },
      () => now,
    );
    expect((await scheduler.run("a", 5, async () => true)).status).toBe(
      "complete",
    );
    expect((await scheduler.run("b", 1, async () => true)).status).toBe(
      "skipped",
    );
    now = new Date("2026-09-08T12:00:00Z");
    expect((await scheduler.run("b", 1, async () => true)).status).toBe(
      "complete",
    );
  });
  it("persists budget use in caller-owned state", async () => {
    const budget = { utcDay: "", usedTokens: 0 };
    const scheduler = new BudgetScheduler(
      10,
      budget,
      () => new Date("2026-09-07T00:00:00Z"),
    );
    await scheduler.run("a", 4, async () => true);
    expect(budget).toEqual({ utcDay: "2026-09-07", usedTokens: 4 });
    expect(
      (
        await new BudgetScheduler(
          10,
          budget,
          () => new Date("2026-09-07T01:00:00Z"),
        ).run("b", 7, async () => true)
      ).status,
    ).toBe("skipped");
  });
});

describe("dashboard", () => {
  it("renders dependency, import, pattern, candidate, evaluation, and review surfaces", () => {
    const html = renderDashboard({
      status: "offline",
      imported: 3,
      redactions: 2,
      patterns: [],
      candidates: [],
      evaluations: [],
    });
    for (const label of [
      "Dependency",
      "Import",
      "Patterns",
      "Candidates",
      "Evaluations",
      "Review",
    ])
      expect(html).toContain(label);
    for (const action of [
      "Import evidence",
      "Compile patterns",
      "Propose candidate",
      "Evaluate",
      "Cancel",
      "Retry",
    ])
      expect(html).toContain(action);
    expect(html).toContain("Offline");
  });
});
