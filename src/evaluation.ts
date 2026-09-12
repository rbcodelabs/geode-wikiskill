import { ThreadsAdapter } from "./threads-adapter";
import {
  gradeFixture,
  parseAndValidateOutput,
  sha256,
  type LoadedContract,
} from "./playbook";

interface GradedScore {
  score: number;
  failures: string[];
  passes: Record<string, boolean>;
}
interface Score extends GradedScore {
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}
export function gradeEvaluation(input: {
  baseline: GradedScore;
  candidate: GradedScore;
  policy: { minimumMargin: number; criticalFixtures: string[] };
}): { decision: "reject" | "review"; reason: string } {
  if (
    input.policy.criticalFixtures.some(
      (id) => input.candidate.passes[id] !== true,
    )
  )
    return {
      decision: "reject",
      reason: "candidate failed a critical fixture",
    };
  if (
    input.candidate.failures.some(
      (id) =>
        input.policy.criticalFixtures.includes(id) &&
        !input.baseline.failures.includes(id),
    )
  )
    return { decision: "reject", reason: "critical fixture regression" };
  if (input.candidate.score - input.baseline.score < input.policy.minimumMargin)
    return { decision: "reject", reason: "insufficient improvement" };
  return {
    decision: "review",
    reason: "candidate improved and every critical fixture passed",
  };
}

export async function evaluateCandidate(
  adapter: ThreadsAdapter,
  contract: LoadedContract,
  candidate: string,
  setCancellation: (cancel?: () => Promise<void>) => void = () => undefined,
) {
  if (contract.manifest.skillId !== "integration-routing")
    throw new Error("Candidate skill ID does not match pilot scope");
  if (
    Math.ceil(Buffer.byteLength(candidate, "utf8") / 4) >
    contract.manifest.budgets.maxCandidateTokens
  )
    throw new Error("Candidate exceeds contract token budget");
  const executionHash = sha256(
    JSON.stringify({
      harness: "claude",
      model: "claude-sonnet-4-5",
      maxTurns: 1,
    }),
  );
  const run = async (
    content: string,
    role: "baseline" | "candidate",
  ): Promise<Score> => {
    let earned = 0;
    let total = 0;
    const failures: string[] = [];
    const passes: Record<string, boolean> = {};
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const entry of contract.fixtures) {
      const fixture = entry.fixture;
      total += entry.weight;
      const key = sha256(
        [
          "geode-wikiskill",
          contract.manifest.skillId,
          sha256(content),
          contract.manifest.source.hash,
          contract.manifest.source.purposeHash,
          contract.contractHash,
          entry.hash,
          role,
          executionHash,
        ].join("\0"),
      );
      const created = await adapter.requireApi().constrainedRuns.create({
        ownerPluginId: "geode-wikiskill",
        idempotencyKey: key,
        harness: "claude",
        model: "claude-sonnet-4-5",
        systemInstructions: `${fixture.prompt.system}\n\n<skill-candidate>\n${content}\n</skill-candidate>`,
        prompt: fixture.prompt.user,
        maxTurns: 1,
        maxBudgetUsd: Math.min(1, fixture.execution.maxTokens / 4000),
        timeoutMs: fixture.execution.timeoutSeconds * 1000,
      });
      setCancellation(async () => {
        await adapter.requireApi().constrainedRuns.cancel(created.runId);
      });
      const result = await adapter
        .requireApi()
        .constrainedRuns.wait(created.runId, {
          timeoutMs: fixture.execution.timeoutSeconds * 1000,
        });
      if (result.status !== "completed")
        throw new Error(
          result.status === "running"
            ? "Constrained evaluation timed out"
            : result.error.message,
        );
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.costUsd += result.usage.costUsd;
      const actual = parseAndValidateOutput(
        result.output,
        fixture.outputContract,
      );
      const passed = gradeFixture(fixture, actual);
      passes[fixture.id] = passed;
      if (passed) earned += entry.weight;
      else failures.push(fixture.id);
    }
    return { score: total ? earned / total : 0, failures, passes, usage };
  };
  try {
    const baseline = await run(contract.skillText, "baseline");
    const evaluated = await run(candidate, "candidate");
    const criticalFixtures = contract.fixtures
      .filter((item) => item.critical)
      .map((item) => item.fixture.id);
    const graded = gradeEvaluation({
      baseline,
      candidate: evaluated,
      policy: {
        minimumMargin: contract.manifest.thresholds.minimumAggregateImprovement,
        criticalFixtures,
      },
    });
    return {
      ...graded,
      baseline,
      candidate: evaluated,
      promoted: false as const,
    };
  } finally {
    setCancellation(undefined);
  }
}
