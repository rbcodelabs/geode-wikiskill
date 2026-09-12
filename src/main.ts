import { ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, type EventRef, } from "obsidian";
import { WikiSkillDashboardController, type DashboardModel } from "./dashboard";
import { WikiSkillPluginActionTarget } from "./plugin-actions";
import { TraceImporter } from "./importer";
import { defaultState, migrateState, type PluginState } from "./state";
import { ThreadsAdapter } from "./threads-adapter";
import { VaultWikiStore } from "./vault-store";
import { BudgetScheduler } from "./scheduler";
import { JobQueue, ScopeLock } from "./jobs";
import { discoverSkills, scanDocuments, compileFrictions, reviewCandidate, hash } from "./learning";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateScenarios, parseScenarios } from './scenarios';
import { redactTrace } from './privacy';
import { classifyVaultSkills, resolveAttribution, validAuthoredFolder } from './local-integration';
import { realpath } from 'node:fs/promises';
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
        this.scheduler = new BudgetScheduler(() => this.state.settings.dailyTokenBudget, this.state.budget, () => new Date(), () => this.saveData(this.state));
        const workspace = this.app.workspace as unknown as WorkspaceExternalEvents;
        this.registerEvent(workspace.on("claude-threads:api-ready", () => {
            this.hostEvents.dispatchEvent(new Event("claude-threads:api-ready"));
            void this.reconcileProvider();
        }));
        this.registerEvent(workspace.on("claude-threads:api-stopping", () => {
            this.hostEvents.dispatchEvent(new Event("claude-threads:api-stopping"));
            void this.refresh();
        }));
        this.adapter = new ThreadsAdapter(() => (this.app as unknown as {
            plugins?: {
                plugins?: Record<string, unknown>;
            };
        }).plugins?.plugins?.["claude-threads"], this.hostEvents);
        this.adapter.start();
        this.queue = new JobQueue(this.adapter, (id, cancel) => {
            if (cancel)
                this.activeCancels.set(id, cancel);
            else
                this.activeCancels.delete(id);
        }, this.state.jobs, () => this.persist(), this.scopeLock);
        if (this.queue.reconcileInterrupted())
            await this.persist();
        const actions = new WikiSkillPluginActionTarget({
            importEvidence: () => this.scanVault(),
            review: (id, status) => this.review(id, status),
            compile: () => this.compile(),
            propose: () => this.propose(),
            evaluateLatest: () => this.evaluateLatest(),
            cancel: () => this.cancel(),
            retry: () => this.retry(),
        }, {
            saveData: () => this.saveData(this.state),
            writeVaultPackets: () => this.exportPackets(),
            afterExport: async () => {
                await this.refresh();
                new Notice("Review packets exported to the configured knowledge folder.");
            },
        });
        this.registerView(VIEW_TYPE, (leaf) => new WikiSkillView(leaf, () => this.dashboardModel(), new WikiSkillDashboardController(actions)));
        this.addRibbonIcon("network", "Open WikiSkill Evolution", () => void this.openDashboard());
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
            name: "Propose a skill improvement",
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
        this.registerInterval(window.setInterval(() => {
            void this.runScheduledCycle().catch((error) => {
                console.error("WikiSkill scheduled cycle failed", error);
                new Notice("WikiSkill scheduled cycle failed; see console for details");
            });
        }, 15 * 60 * 1000));
    }
    onunload(): void {
        this.adapter.stop();
    }
    private async exportPackets(): Promise<void> {
        await this.discover();
        for (const c of this.state.candidates.filter(c => c.status === "approved")) {
            await this.verifyEvidence(c);
            reviewCandidate(this.state, c.id, "approved");
        }
        this.state.vaultScan.outputRoots = [...new Set([...this.state.vaultScan.outputRoots, this.state.settings.outputRoot])];
        await this.saveData(this.state);
        await new VaultWikiStore(this.app.vault).write(this.state);
    }
    async persist(): Promise<void> {
        await this.saveData(this.state);
        await this.refresh();
    }
    async importEvidence(): Promise<void> {
        try {
            const storage = (this.app as unknown as {
                secretStorage?: {
                    getSecret(id: string): string | null;
                };
            }).secretStorage;
            if (!storage)
                throw new Error("Secure secret storage is unavailable; trace import is blocked");
            const secrets = this.state.settings.secretIds.map((id) => storage.getSecret(id));
            if (secrets.some((value) => value === null))
                throw new Error("A configured redaction secret is unavailable; trace import is blocked");
            const importer = new TraceImporter(this.adapter, new Set(this.state.consentedProjects), secrets as string[]);
            const result = await importer.prepareBatch(this.state.sourceCheckpoints, this.state.settings.importLimit, {
                sourcePageCursor: this.state.importProgress.sourcePageCursor,
                maxSources: 100,
                maxBytes: this.state.settings.importLimit * 65536,
            });
            const importedAt = new Date().toISOString();
            const merged = new Map<string, {
                id: string;
                skill: string;
                action: string;
                outcome: import("./model").Outcome;
                importedAt: string;
            }>();
            for (const event of result.events) {
                const prior = merged.get(event.id) ??
                    this.state.evidence.find((item) => item.id === event.id);
                merged.set(event.id, {
                    id: event.id,
                    skill: event.skill!,
                    action: event.text || prior?.action || `Invoke ${event.skill}`,
                    outcome: event.outcome === "unknown"
                        ? (prior?.outcome ?? "unknown")
                        : event.outcome,
                    importedAt,
                });
            }
            const incoming = [...merged.values()];
            const known = new Set(this.state.evidence.map((item) => item.id));
            this.state.evidence.push(...incoming.filter((item) => !known.has(item.id)));
            for (const item of incoming.filter((item) => known.has(item.id))) {
                const existing = this.state.evidence.find((value) => value.id === item.id);
                if (existing && item.outcome !== "unknown")
                    existing.outcome = item.outcome;
            }
            this.state.sourceCheckpoints = result.checkpoints;
            const added = incoming.filter((item) => !known.has(item.id)).length;
            this.state.importProgress = {
                sourcePageCursor: result.sourcePageCursor,
                scannedSources: this.state.importProgress.scannedSources + result.scannedSources,
                scannedBytes: this.state.importProgress.scannedBytes + result.scannedBytes,
                importedEvents: this.state.importProgress.importedEvents + added,
                redactions: this.state.importProgress.redactions + result.redactions,
            };
            await this.persist();
            new Notice(`Imported ${added} eligible event(s).`);
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : "Import failed");
        }
    }
    async compile(): Promise<void> {
        this.state.patterns = compileFrictions(this.state.evidence);
        await this.persist();
        new Notice(`Compiled ${this.state.patterns.length} pattern(s).`);
    }
    async discover(): Promise<void> {
        const adapter = this.app.vault.adapter as unknown as {
            getBasePath?(): string;
        };
        const base = adapter.getBasePath?.();
        const vault = base ? await realpath(base) : undefined;
        if(!validAuthoredFolder(this.state.settings.authoredSkillFolder)) throw new Error('Authored skills folder must be a contained visible vault folder');
        const roots = [
            ...['.agents/skills', '.claude/skills', '.codex/skills'].map(p => join(homedir(), p)),
            ...(vault ? ['.agents/skills', '.claude/skills', '.codex/skills', this.app.vault.configDir + '/plugins/claude-threads/skills', this.app.vault.configDir + '/plugins/claude-threads/skill-sources'].map(p => join(vault, p)) : []),
            ...this.state.settings.skillRoots,
            ...(vault?[join(vault,this.state.settings.authoredSkillFolder)]:[]),
        ];
        this.state.skills = await discoverSkills([...new Set(roots)], undefined, this.redactionSecrets());
        if(vault) this.state.skills=classifyVaultSkills(this.state.skills,vault,this.state.settings.authoredSkillFolder);
    }
    async scanVault(): Promise<void> {
        await this.scopeLock.run('vault-scan', async () => {
            await this.discover();
            const files = this.app.vault.getMarkdownFiles();
            await scanDocuments(this.state, files.map(f => ({ path: f.path, size: f.stat?.size ?? (f as unknown as {size?:number}).size ?? Infinity })), async (path) => {
                const file = files.find(f => f.path === path);
                if (!file)
                    throw new Error('Source disappeared during scan');
                return this.app.vault.read(file);
            }, this.redactionSecrets());
            this.applyRetention();
            this.state.patterns = compileFrictions(this.state.evidence);
            await this.persist();
        });
    }
    private redactionSecrets(): string[] {
        if (!this.state.settings.secretIds.length)
            return [];
        const storage = (this.app as unknown as {
            secretStorage?: {
                getSecret(id: string): string | null;
            };
        }).secretStorage;
        if (!storage)
            throw new Error('Configured secret redaction is unavailable');
        return this.state.settings.secretIds.map(id => {
            const secret = storage.getSecret(id);
            if (!secret)
                throw new Error('Configured redaction secret is unavailable');
            return secret;
        });
    }
    async propose(): Promise<void> {
        try {
            await this.discover();
            const signature = (p: import('./model').Pattern) => hash(JSON.stringify({ evidence: this.state.evidence.filter(e => [...p.evidence, ...p.counterexamples].includes(e.id)).map(e => ({ id: e.id, action: e.action, sourceHash: e.sourceHash, outcome: e.outcome })), source: resolveAttribution(p.skill,this.state.skills)?.hash }));
            const pattern = this.state.patterns.find(p => !this.state.candidates.some(c => c.patternId === p.id && c.patternSignature === signature(p)));
            if (!pattern)
                throw new Error('Scan evidence first; no new friction is awaiting a proposal');
            if (this.adapter.status !== 'full')
                throw new Error('Agent Threads authoring is unavailable; local findings remain available');
            const skill = resolveAttribution(pattern.skill,this.state.skills);
            const ids = [...pattern.evidence, ...pattern.counterexamples];
            const evidence = this.state.evidence.filter(e => ids.includes(e.id));
            const input = JSON.stringify({ instruction: skill ? 'Return the complete revised SKILL.md text and rationale. Preserve frontmatter name and description, unrelated guidance, and references to package resources. Scope is SKILL.md only; do not propose resource deletion.' : 'Propose missing guidance or a tooling investigation; do not assume a skill is at fault.', target: skill?.name ?? 'unmapped', baseline: skill?.content, evidence, uncertainty: 'Vault outcomes are inferred. Successes are possible counterevidence. Correlation is not causation.' });
            const result = await this.scheduler.run(pattern.skill, Math.ceil(Buffer.byteLength(input) / 3) + 4096, () => this.queue.propose(pattern.skill, input, undefined, 4096));
            if (!result.value)
                throw new Error('Daily budget exhausted or operation already running');
            const candidate = result.value;
            candidate.content = redactTrace(candidate.content, this.redactionSecrets()).text;
            if (candidate.rationale)
                candidate.rationale = redactTrace(candidate.rationale, this.redactionSecrets()).text;
            candidate.patternSignature = signature(pattern);
            candidate.patternId = pattern.id;
            candidate.skill = skill?.id ?? pattern.skill;
            candidate.sourceHash = skill?.hash;
            candidate.baselineContent = skill?.content;
            candidate.sourceEvidence = evidence.filter(e => e.sourcePath && e.sourceHash).map(e => ({ path: e.sourcePath!, hash: e.sourceHash! }));
            candidate.status = 'review';
            candidate.verification = 'Unverified proposal. No behavioral comparison has been run.';
            this.state.candidates.push(candidate);
            await this.persist();
        }
        catch (error) {
            await this.recordFailure('propose', error);
        }
    }
    async evaluateLatest(candidateId?: string): Promise<void> {
        const c = candidateId ? this.state.candidates.find(x => x.id === candidateId) : this.state.candidates.at(-1);
        if (!c)
            return;
        try {
            await this.discover();
            const skill = this.state.skills.find(s => s.id === c.skill);
            if (c.sourceHash && skill?.hash !== c.sourceHash)
                throw new Error('Installed skill changed; generate a new proposal');
            if (!c.baselineContent)
                throw new Error('No installed baseline; proposal remains unverified');
            const scenarios = parseScenarios(this.state.settings.scenarioJson || '[]');
            const id = 'evaluate-' + c.id;
            const run = await this.scheduler.run(c.skill, scenarios.reduce((n, s) => n + Math.ceil((c.baselineContent!.length + c.content.length + s.prompt.length * 2) / 3) + 8192, 0), () => this.scopeLock.run(c.skill, () => evaluateScenarios(this.adapter.requireApi(), c.baselineContent!, c.content, scenarios, cancel => { if (cancel)
                this.activeCancels.set(id, cancel);
            else
                this.activeCancels.delete(id); })));
            if (!run.value)
                throw new Error('Daily budget exhausted or evaluation already running');
            const r = run.value;
            const regressions = Object.entries(r.fixtureOutcomes).filter(([, v]) => v.baseline && !v.candidate).map(([id]) => id);
            this.state.evaluations.push({ id: id + '-' + Date.now(), candidateId: c.id, decision: regressions.length ? 'reject' : 'review', ...r, failures: regressions, promoted: false, createdAt: new Date().toISOString(), canonicalSkillHash: c.sourceHash, contractHash: hash(JSON.stringify(scenarios)) });
            c.verification = `Independent exact-output scenarios: ${r.baselineScore} → ${r.candidateScore}. ${regressions.length} regressions. This limited sample does not prove general improvement.`;
        }
        catch (error) {
            c.verification = 'Unverified: ' + (error instanceof Error ? error.message : 'evaluation failed');
            new Notice(c.verification);
        }
        await this.persist();
    }
    async review(id: string, status: 'approved' | 'dismissed' | 'deferred'): Promise<void> {
        await this.discover();
        const candidate = this.state.candidates.find(c => c.id === id);
        if (candidate && status === 'approved')
            await this.verifyEvidence(candidate);
        reviewCandidate(this.state, id, status);
        await this.persist();
    }
    private async verifyEvidence(candidate: import('./model').Candidate): Promise<void> {
        for (const source of candidate.sourceEvidence ?? []) {
            const file = this.app.vault.getFileByPath(source.path);
            if (!file || hash(await this.app.vault.read(file)) !== source.hash)
                throw new Error('Evidence source changed; rescan and generate a new proposal');
        }
    }
    async retry(): Promise<void> {
        // Rebuild provenance from current sources; never append a bare queue retry result.
        await this.propose();
        return;
    }
    async cancel(): Promise<void> {
        for (const [id, cancel] of this.activeCancels)
            if (id.startsWith('evaluate-')) {
                await cancel();
                return;
            }
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
        }
        finally {
            this.activeCancels.delete(running.id);
        }
    }
    private async recordFailure(type: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : `${type} failed`;
        new Notice(message);
    }
    private async runScheduledCycle(): Promise<void> {
        if (!this.state.settings.scheduledScan)
            return;
        this.applyRetention();
        await this.scanVault();
        if (this.adapter.status === 'full' && this.state.consentedProjects.length)
            await this.importEvidence();
        this.state.patterns = compileFrictions(this.state.evidence);
        await this.persist();
    }
    private applyRetention(): void {
        const cutoff = Date.now() - this.state.settings.retentionDays * 86400000;
        this.state.evidence = this.state.evidence.filter((item) => !item.importedAt || Date.parse(item.importedAt) >= cutoff);
        this.state.candidates = this.state.candidates.filter((item) => Date.parse(item.createdAt) >= cutoff || ['review', 'approved', 'dismissed', 'deferred'].includes(item.status));
        this.state.evaluations = this.state.evaluations.filter((item) => Date.parse(item.createdAt) >= cutoff || item.decision === "review");
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
            skills: this.state.skills,
            evidence: this.state.evidence,
            importProgress: this.state.importProgress,
        };
    }
    private async openDashboard(): Promise<void> {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (!leaf)
            return;
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
    }
    private async refresh(): Promise<void> {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
            if (leaf.view instanceof WikiSkillView)
                leaf.view.render();
    }
    private async reconcileProvider(): Promise<void> {
        if (this.queue?.reconcileInterrupted())
            await this.persist();
        else
            await this.refresh();
    }
}
class WikiSkillView extends ItemView {
    constructor(leaf: WorkspaceLeaf, private readonly model: () => DashboardModel, private readonly controller: WikiSkillDashboardController) {
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
    constructor(app: WikiSkillPlugin["app"], private readonly plugin: WikiSkillPlugin) {
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
            .addText((text) => text
            .setValue(this.plugin.state.consentedProjects.join(", "))
            .onChange(async (value) => {
            this.plugin.state.consentedProjects = value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
            await this.plugin.persist();
        }));
        new Setting(this.containerEl)
            .setName("Knowledge output folder")
            .addText((text) => text
            .setValue(this.plugin.state.settings.outputRoot)
            .onChange(async (value) => {
            const path = value.trim();
            if (!path || path.startsWith("/") || path.split("/").includes(".."))
                return void new Notice("Output folder must be a contained vault-relative path.");
            this.plugin.state.settings.outputRoot = path;
            await this.plugin.persist();
        }));
        new Setting(this.containerEl).setName('Authored skills folder').setDesc('Vault-relative folder, default Skills. Match Agent Threads local skills folder if customized.').addText(text=>text.setValue(this.plugin.state.settings.authoredSkillFolder).onChange(async value=>{if(validAuthoredFolder(value)){this.plugin.state.settings.authoredSkillFolder=value;await this.plugin.persist();}}));
        new Setting(this.containerEl).setName('Additional skill directories').setDesc('Absolute directories, one per line. Conventional vault/home skill directories are discovered automatically.').addTextArea(text => text.setValue(this.plugin.state.settings.skillRoots.join('\n')).onChange(async (value) => { this.plugin.state.settings.skillRoots = value.split('\n').map(x => x.trim()).filter(Boolean); await this.plugin.persist(); }));
        new Setting(this.containerEl).setName('Excluded vault folders').setDesc('One vault-relative path per line. WikiSkill outputs are always excluded.').addTextArea(text => text.setValue(this.plugin.state.settings.exclusions.join('\n')).onChange(async (value) => { this.plugin.state.settings.exclusions = value.split('\n').map(x => x.trim()).filter(Boolean); await this.plugin.persist(); }));
        new Setting(this.containerEl).setName('Scan every 15 minutes').setDesc('Local incremental scans; proposals require a separate action.').addToggle(toggle => toggle.setValue(this.plugin.state.settings.scheduledScan).onChange(async (value) => { this.plugin.state.settings.scheduledScan = value; await this.plugin.persist(); }));
        new Setting(this.containerEl).setName('Independent evaluation scenarios').setDesc('JSON array of {id,prompt,expected}; 1–10 cases for the latest candidate. Exact-output checks run on baseline and candidate; keep these independent of proposal generation.').addTextArea(text => text.setValue(this.plugin.state.settings.scenarioJson).onChange(async (value) => { this.plugin.state.settings.scenarioJson = value; await this.plugin.persist(); }));
        for (const [key, label] of [['dailyTokenBudget', 'Daily token reservation budget'], ['importLimit', 'Files per scan']] as const)
            new Setting(this.containerEl).setName(label).setDesc(key === 'dailyTokenBudget' ? 'Estimates reserve daily capacity; not a measured-token ceiling. Each model call is capped at $0.10.' : 'Positive integer; scans also enforce byte limits.').addText(text => text.setValue(String(this.plugin.state.settings[key])).onChange(async (value) => { const n = Number(value); if (Number.isSafeInteger(n) && n > 0) {
                this.plugin.state.settings[key] = n;
                await this.plugin.persist();
            } }));
        new Setting(this.containerEl)
            .setName("Redaction secret IDs")
            .setDesc("Comma-separated IDs in Geode Secret Storage. Secret values are never persisted by WikiSkill.")
            .addText((text) => text
            .setValue(this.plugin.state.settings.secretIds.join(", "))
            .onChange(async (value) => {
            this.plugin.state.settings.secretIds = value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
            await this.plugin.persist();
        }));
    }
}
