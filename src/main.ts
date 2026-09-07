import {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  type EventRef,
} from "obsidian";
import { compilePatterns } from "./compiler";
import {
  dispatchDashboardAction,
  persistReviewPackets,
  WikiSkillDashboardController,
  type DashboardModel,
} from "./dashboard";
import { TraceImporter } from "./importer";
import { defaultState, migrateState, type PluginState } from "./state";
import { ThreadsAdapter } from "./threads-adapter";
import { VaultWikiStore } from "./vault-store";
import { BudgetScheduler } from "./scheduler";
import { JobQueue, ScopeLock } from "./jobs";
import { evaluateCandidate } from "./evaluation";
import { loadEvaluationContract } from "./playbook";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const VIEW_TYPE = "geode-wikiskill:dashboard";
interface WorkspaceExternalEvents {
  on(name: string, callback: () => void): EventRef;
}

export default class WikiSkillPlugin extends Plugin {
  state: PluginState = defaultState();
  private readonly hostEvents = new EventTarget();
  private adapter!: ThreadsAdapter;
  private activeCancels = new Map<string, () => Promise<void>>();
  private scheduler!: BudgetScheduler;
  private queue!: JobQueue;
  private readonly scopeLock = new ScopeLock();

  async onload(): Promise<void> {
    this.state = migrateState(await this.loadData());
    this.scheduler = new BudgetScheduler(
      this.state.settings.dailyTokenBudget,
      this.state.budget,
      () => new Date(),
      () => this.saveData(this.state),
    );
    const workspace = this.app.workspace as unknown as WorkspaceExternalEvents;
    this.registerEvent(
      workspace.on("claude-threads:api-ready", () => {
        this.hostEvents.dispatchEvent(new Event("claude-threads:api-ready"));
        void this.reconcileProvider();
      }),
    );
    this.registerEvent(
      workspace.on("claude-threads:api-stopping", () => {
        this.hostEvents.dispatchEvent(new Event("claude-threads:api-stopping"));
        void this.refresh();
      }),
    );
    this.adapter = new ThreadsAdapter(
      () =>
        (
          this.app as unknown as {
            plugins?: { plugins?: Record<string, unknown> };
          }
        ).plugins?.plugins?.["claude-threads"],
      this.hostEvents,
    );
    this.adapter.start();
    this.queue = new JobQueue(
      this.adapter,
      (id, cancel) => {
        if (cancel) this.activeCancels.set(id, cancel);
        else this.activeCancels.delete(id);
      },
      this.state.jobs,
      () => this.persist(),
      this.scopeLock,
    );
    if (this.queue.reconcileInterrupted()) await this.persist();
    this.registerView(
      VIEW_TYPE,
      (leaf) =>
        new WikiSkillView(
          leaf,
          () => this.dashboardModel(),
          new WikiSkillDashboardController(this),
        ),
    );
    this.addRibbonIcon(
      "network",
      "Open WikiSkill Evolution",
      () => void this.openDashboard(),
    );
    this.addCommand({
      id: "open-dashboard",
      name: "Open WikiSkill Evolution dashboard",
      callback: () => void this.openDashboard(),
    });
    this.addCommand({
      id: "import-evidence",
      name: "Import consented Agent Threads evidence",
      callback: () => void this.importEvidence(),
    });
    this.addCommand({
      id: "compile-patterns",
      name: "Compile imported evidence into patterns",
      callback: () => void this.compile(),
    });
    this.addCommand({
      id: "propose-candidate",
      name: "Propose an integration-routing candidate",
      callback: () => void this.propose(),
    });
    this.addCommand({
      id: "evaluate-candidate",
      name: "Evaluate the latest candidate",
      callback: () => void this.evaluateLatest(),
    });
    this.addCommand({
      id: "retry-last-job",
      name: "Retry the last failed operation",
      callback: () => void this.retry(),
    });
    this.addSettingTab(new WikiSkillSettings(this.app, this));
    this.registerInterval(
      window.setInterval(
        () => {
          void this.runScheduledCycle().catch((error) => {
            console.error("WikiSkill scheduled cycle failed", error);
            new Notice(
              "WikiSkill scheduled cycle failed; see console for details",
            );
          });
        },
        15 * 60 * 1000,
      ),
    );
  }
  onunload(): void {
    this.adapter.stop();
  }

  async persist(): Promise<void> {
    await this.saveData(this.state);
    await new VaultWikiStore(this.app.vault).write(this.state);
    await this.refresh();
  }
  async importEvidence(): Promise<void> {
    try {
      const storage = (
        this.app as unknown as {
          secretStorage?: { getSecret(id: string): string | null };
        }
      ).secretStorage;
      if (!storage)
        throw new Error(
          "Secure secret storage is unavailable; trace import is blocked",
        );
      const secrets = this.state.settings.secretIds.map((id) =>
        storage.getSecret(id),
      );
      if (secrets.some((value) => value === null))
        throw new Error(
          "A configured redaction secret is unavailable; trace import is blocked",
        );
      const importer = new TraceImporter(
        this.adapter,
        new Set(this.state.consentedProjects),
        secrets as string[],
      );
      const result = await importer.prepareBatch(
        this.state.sourceCheckpoints,
        this.state.settings.importLimit,
        {
          sourcePageCursor: this.state.importProgress.sourcePageCursor,
          maxSources: 100,
          maxBytes: this.state.settings.importLimit * 65536,
        },
      );
      const importedAt = new Date().toISOString();
      const merged = new Map<
        string,
        {
          id: string;
          skill: string;
          action: string;
          outcome: import("./model").Outcome;
          importedAt: string;
        }
      >();
      for (const event of result.events) {
        const prior =
          merged.get(event.id) ??
          this.state.evidence.find((item) => item.id === event.id);
        merged.set(event.id, {
          id: event.id,
          skill: event.skill!,
          action: event.text || prior?.action || `Invoke ${event.skill}`,
          outcome:
            event.outcome === "unknown"
              ? (prior?.outcome ?? "unknown")
              : event.outcome,
          importedAt,
        });
      }
      const incoming = [...merged.values()];
      const known = new Set(this.state.evidence.map((item) => item.id));
      this.state.evidence.push(
        ...incoming.filter((item) => !known.has(item.id)),
      );
      for (const item of incoming.filter((item) => known.has(item.id))) {
        const existing = this.state.evidence.find(
          (value) => value.id === item.id,
        );
        if (existing && item.outcome !== "unknown")
          existing.outcome = item.outcome;
      }
      this.state.sourceCheckpoints = result.checkpoints;
      const added = incoming.filter((item) => !known.has(item.id)).length;
      this.state.importProgress = {
        sourcePageCursor: result.sourcePageCursor,
        scannedSources:
          this.state.importProgress.scannedSources + result.scannedSources,
        scannedBytes:
          this.state.importProgress.scannedBytes + result.scannedBytes,
        importedEvents: this.state.importProgress.importedEvents + added,
        redactions: this.state.importProgress.redactions + result.redactions,
      };
      await this.persist();
      new Notice(`Imported ${added} eligible event(s).`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Import failed");
    }
  }
  async compile(): Promise<void> {
    this.state.patterns = compilePatterns(this.state.evidence);
    await this.persist();
    new Notice(`Compiled ${this.state.patterns.length} pattern(s).`);
  }
  async propose(): Promise<void> {
    if (this.adapter.status !== "full")
      return void new Notice(
        "Agent Threads authoring capability is unavailable.",
      );
    const evidence = this.state.patterns
      .filter((pattern) => pattern.skill === "integration-routing")
      .map(
        (pattern) =>
          `${pattern.action}\nCounterexamples: ${pattern.counterexamples.join(", ")}`,
      )
      .join("\n\n");
    if (!evidence)
      return void new Notice(
        "Compile integration-routing evidence before proposing.",
      );
    try {
      const { evaluationManifestPath, canonicalSkillPath } =
        this.state.settings;
      if (!evaluationManifestPath || !canonicalSkillPath)
        throw new Error(
          "Configure the Playbook manifest and canonical skill paths before proposing",
        );
      const contract = await loadEvaluationContract(evaluationManifestPath);
      if (contract.manifest.skillId !== "integration-routing")
        throw new Error(
          "Candidate skill ID does not match evaluation contract",
        );
      const canonicalHash = createHash("sha256")
        .update(await readFile(canonicalSkillPath))
        .digest("hex");
      if (canonicalHash !== contract.manifest.source.hash)
        throw new Error(
          "Configured canonical skill does not match evaluation contract",
        );
      const scheduled = await this.scheduler.run(
        "integration-routing",
        2000,
        () =>
          this.queue.propose(
            "integration-routing",
            evidence,
            undefined,
            contract.manifest.budgets.maxCandidateTokens,
          ),
      );
      if (scheduled.status === "skipped" || !scheduled.value)
        throw new Error("Daily budget exhausted or operation already running");
      const candidate = scheduled.value;
      candidate.sourceHash = canonicalHash;
      candidate.baselineContent = contract.skillText;
      candidate.purposeHash = contract.manifest.source.purposeHash;
      candidate.contractHash = contract.contractHash;
      candidate.fixtureHashes = Object.fromEntries(
        contract.fixtures.map((item) => [item.fixture.id, item.hash]),
      );
      this.state.candidates.push(candidate);
      await this.persist();
      new Notice("Created one isolated candidate for review.");
    } catch (error) {
      await this.recordFailure("propose", error);
    }
  }
  async evaluateLatest(candidateId?: string): Promise<void> {
    const candidate = candidateId
      ? this.state.candidates.find((item) => item.id === candidateId)
      : [...this.state.candidates]
          .reverse()
          .find((item) => item.status === "draft");
    if (!candidate) return void new Notice("No draft candidate is available.");
    const priorJob = this.state.jobs.find(
      (item) => item.id === `evaluate-${candidate.id}`,
    );
    const evaluationManifestPath =
      priorJob?.input.manifestPath ??
      this.state.settings.evaluationManifestPath;
    const canonicalSkillPath =
      priorJob?.input.canonicalSkillPath ??
      this.state.settings.canonicalSkillPath;
    if (!evaluationManifestPath || !canonicalSkillPath)
      return void new Notice(
        "Configure the Playbook manifest and canonical skill paths first.",
      );
    try {
      const contract = await loadEvaluationContract(evaluationManifestPath);
      if (contract.manifest.skillId !== candidate.skill)
        throw new Error(
          "Candidate skill ID does not match evaluation contract",
        );
      const configuredSkillHash = createHash("sha256")
        .update(await readFile(canonicalSkillPath))
        .digest("hex");
      if (configuredSkillHash !== contract.manifest.source.hash)
        throw new Error(
          "Configured canonical skill does not match evaluation contract",
        );
      const jobId = `evaluate-${candidate.id}`;
      const expectedInput = {
        candidateId: candidate.id,
        manifestPath: evaluationManifestPath,
        canonicalSkillPath,
        candidateHash: createHash("sha256")
          .update(candidate.content)
          .digest("hex"),
        sourceHash: contract.manifest.source.hash,
        contractHash: contract.contractHash,
        fixtureHashes: Object.fromEntries(
          contract.fixtures.map((item) => [item.fixture.id, item.hash]),
        ),
        execution: {
          harness: "claude",
          model: "claude-sonnet-4-5",
          maxTurns: 1,
        },
      };
      let job = this.state.jobs.find((item) => item.id === jobId);
      if (!job) {
        const input = expectedInput;
        job = {
          id: jobId,
          type: "evaluate",
          skill: candidate.skill,
          status: "queued",
          idempotencyKey: createHash("sha256")
            .update(JSON.stringify(input))
            .digest("hex"),
          input,
          evidenceHash: candidate.evidenceHash,
        };
        this.state.jobs.push(job);
      } else if (JSON.stringify(job.input) !== JSON.stringify(expectedInput))
        throw new Error(
          "Evaluation retry inputs are stale; create a new candidate evaluation",
        );
      job.status = "running";
      job.error = undefined;
      await this.persist();
      candidate.sourceHash = contract.manifest.source.hash;
      candidate.purposeHash = contract.manifest.source.purposeHash;
      candidate.contractHash = contract.contractHash;
      candidate.fixtureHashes = Object.fromEntries(
        contract.fixtures.map((entry) => [entry.fixture.id, entry.hash]),
      );
      const estimatedTokens = contract.fixtures.reduce(
        (sum, item) => sum + item.fixture.execution.maxTokens * 2,
        0,
      );
      const scheduled = await this.scheduler.run(
        candidate.skill,
        estimatedTokens,
        () =>
          this.scopeLock.run(candidate.skill, () =>
            evaluateCandidate(
              this.adapter,
              contract,
              candidate.content,
              (cancel) => {
                if (cancel) this.activeCancels.set(jobId, cancel);
                else this.activeCancels.delete(jobId);
              },
            ),
          ),
      );
      if (scheduled.status === "skipped" || !scheduled.value)
        throw new Error("Daily budget exhausted or operation already running");
      const result = scheduled.value;
      if (
        this.state.jobs.find((item) => item.id === jobId)?.status ===
        "cancelled"
      )
        throw new Error("Evaluation was cancelled");
      candidate.status = result.decision === "reject" ? "rejected" : "review";
      this.state.evaluations.push({
        id: `eval-${candidate.id}`,
        candidateId: candidate.id,
        decision: result.decision,
        baselineScore: result.baseline.score,
        candidateScore: result.candidate.score,
        failures: result.candidate.failures,
        promoted: false,
        createdAt: new Date().toISOString(),
        canonicalSkillHash: candidate.sourceHash,
        purposeHash: candidate.purposeHash,
        contractHash: candidate.contractHash,
        fixtureHashes: candidate.fixtureHashes,
        evidenceHash: candidate.evidenceHash,
        baselineResultHash: createHash("sha256")
          .update(JSON.stringify(result.baseline))
          .digest("hex"),
        candidateResultHash: createHash("sha256")
          .update(JSON.stringify(result.candidate))
          .digest("hex"),
        usage: {
          inputTokens:
            result.baseline.usage.inputTokens +
            result.candidate.usage.inputTokens,
          outputTokens:
            result.baseline.usage.outputTokens +
            result.candidate.usage.outputTokens,
          costUsd:
            result.baseline.usage.costUsd + result.candidate.usage.costUsd,
        },
        fixtureOutcomes: Object.fromEntries(
          Object.keys(result.candidate.passes).map((id) => [
            id,
            {
              baseline: result.baseline.passes[id] === true,
              candidate: result.candidate.passes[id] === true,
            },
          ]),
        ),
      });
      job.status = "complete";
      job.outputHash = createHash("sha256")
        .update(JSON.stringify(result))
        .digest("hex");
      await this.persist();
      new Notice(
        result.decision === "review"
          ? "Evaluation passed; human review is required."
          : `Candidate rejected: ${result.reason}`,
      );
    } catch (error) {
      const job = this.state.jobs.find(
        (item) => item.id === `evaluate-${candidate.id}`,
      );
      if (job) {
        if (job.status !== "cancelled") {
          job.status = "failed";
          job.error =
            error instanceof Error ? error.message : "Evaluation failed";
        }
        await this.persist();
      }
      new Notice(error instanceof Error ? error.message : "Evaluation failed");
    }
  }
  async retry(): Promise<void> {
    const last = [...this.state.jobs]
      .reverse()
      .find((j) => j.status === "failed");
    if (!last) return void new Notice("No failed operation to retry.");
    try {
      if (last.type === "evaluate") {
        const c = this.state.candidates.find(
          (x) => x.id === last.input.candidateId,
        );
        if (!c) throw new Error("Stored evaluation candidate is unavailable");
        await this.evaluateLatest(c.id);
      } else {
        const reserved = await this.scheduler.run(
          last.skill,
          2000,
          async () => {
            await this.persist();
            return this.queue.retry(last.id);
          },
        );
        if (reserved.status === "skipped" || !reserved.value)
          throw new Error(
            "Daily budget exhausted or operation already running",
          );
        const out = reserved.value;
        if (
          !Array.isArray(out) &&
          !this.state.candidates.some((x) => x.id === out.id)
        )
          this.state.candidates.push(out);
        if (Array.isArray(out)) this.state.patterns = out;
        await this.persist();
      }
    } catch (e) {
      new Notice(e instanceof Error ? e.message : "Retry failed");
    }
  }
  async cancel(): Promise<void> {
    const running = [...this.state.jobs]
      .reverse()
      .find((j) => j.status === "running" && this.activeCancels.has(j.id));
    if (!running)
      return void new Notice("No authoring or evaluation run is active.");
    running.status = "cancelled";
    await this.persist();
    try {
      await this.activeCancels.get(running.id)!();
      new Notice("Cancellation requested.");
    } finally {
      this.activeCancels.delete(running.id);
    }
  }
  private async handleAction(action: string): Promise<void> {
    await dispatchDashboardAction(this, action);
  }
  async exportReviewPackets(): Promise<void> {
    await persistReviewPackets(
      () => this.saveData(this.state),
      () => new VaultWikiStore(this.app.vault).write(this.state),
    );
    await this.refresh();
    new Notice("Review packets exported to the configured knowledge folder.");
  }
  private async recordFailure(type: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : `${type} failed`;
    new Notice(message);
  }
  private async runScheduledCycle(): Promise<void> {
    this.applyRetention();
    await this.persist();
    if (this.adapter.status !== "full") return;
    await this.scheduler.run(
      "integration-routing",
      this.state.settings.importLimit * 20,
      async () => {
        const before = this.state.evidence.length;
        await this.importEvidence();
        if (this.state.evidence.length === before) return undefined;
        const selected = this.state.evidence.filter(
            (x) => x.skill === "integration-routing",
          ),
          corpus = selected.map((x) => `${x.id}: ${x.action}`).join("\n");
        this.state.patterns = await this.queue.maintain(
          "integration-routing",
          corpus,
          selected.map((x) => x.id),
        );
        await this.persist();
        return true;
      },
    );
  }
  private applyRetention(): void {
    const cutoff = Date.now() - this.state.settings.retentionDays * 86400000;
    this.state.evidence = this.state.evidence.filter(
      (item) => !item.importedAt || Date.parse(item.importedAt) >= cutoff,
    );
    this.state.candidates = this.state.candidates.filter(
      (item) =>
        Date.parse(item.createdAt) >= cutoff || item.status === "review",
    );
    this.state.evaluations = this.state.evaluations.filter(
      (item) =>
        Date.parse(item.createdAt) >= cutoff || item.decision === "review",
    );
  }
  private dashboardModel(): DashboardModel {
    return {
      status: this.adapter.status,
      imported: this.state.evidence.length,
      redactions: this.state.importProgress.redactions,
      patterns: this.state.patterns,
      candidates: this.state.candidates,
      evaluations: this.state.evaluations,
      jobs: this.state.jobs,
      importProgress: this.state.importProgress,
    };
  }
  private async openDashboard(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  private async refresh(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
      if (leaf.view instanceof WikiSkillView) leaf.view.render();
  }
  private async reconcileProvider(): Promise<void> {
    if (this.queue?.reconcileInterrupted()) await this.persist();
    else await this.refresh();
  }
}

class WikiSkillView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly model: () => DashboardModel,
    private readonly controller: WikiSkillDashboardController,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "WikiSkill Evolution";
  }
  getIcon(): string {
    return "network";
  }
  async onOpen(): Promise<void> {
    this.render();
  }
  render(): void {
    this.controller.mount(this.contentEl, this.model());
  }
}

class WikiSkillSettings extends PluginSettingTab {
  constructor(
    app: WikiSkillPlugin["app"],
    private readonly plugin: WikiSkillPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "WikiSkill Evolution" });
    this.containerEl.createEl("p", {
      text: "Only explicitly consented project IDs are imported. Separate multiple IDs with commas.",
    });
    new Setting(this.containerEl)
      .setName("Consented project IDs")
      .setDesc("No projects are enabled by default.")
      .addText((text) =>
        text
          .setValue(this.plugin.state.consentedProjects.join(", "))
          .onChange(async (value) => {
            this.plugin.state.consentedProjects = value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.persist();
          }),
      );
    new Setting(this.containerEl)
      .setName("Knowledge output folder")
      .addText((text) =>
        text
          .setValue(this.plugin.state.settings.outputRoot)
          .onChange(async (value) => {
            const path = value.trim();
            if (!path || path.startsWith("/") || path.split("/").includes(".."))
              return void new Notice(
                "Output folder must be a contained vault-relative path.",
              );
            this.plugin.state.settings.outputRoot = path;
            await this.plugin.persist();
          }),
      );
    new Setting(this.containerEl)
      .setName("Playbook evaluation manifest")
      .setDesc("Absolute path to the governed manifest.json.")
      .addText((text) =>
        text
          .setValue(this.plugin.state.settings.evaluationManifestPath)
          .onChange(async (value) => {
            this.plugin.state.settings.evaluationManifestPath = value.trim();
            await this.plugin.persist();
          }),
      );
    new Setting(this.containerEl)
      .setName("Canonical skill file")
      .setDesc("Absolute path used for stale-hash verification.")
      .addText((text) =>
        text
          .setValue(this.plugin.state.settings.canonicalSkillPath)
          .onChange(async (value) => {
            this.plugin.state.settings.canonicalSkillPath = value.trim();
            await this.plugin.persist();
          }),
      );
    new Setting(this.containerEl)
      .setName("Redaction secret IDs")
      .setDesc(
        "Comma-separated IDs in Geode Secret Storage. Secret values are never persisted by WikiSkill.",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.state.settings.secretIds.join(", "))
          .onChange(async (value) => {
            this.plugin.state.settings.secretIds = value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
            await this.plugin.persist();
          }),
      );
  }
}
