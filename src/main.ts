import { ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, type EventRef } from 'obsidian';
import { compilePatterns } from './compiler';
import { renderDashboard, type DashboardModel } from './dashboard';
import { TraceImporter } from './importer';
import { defaultState, migrateState, type PluginState } from './state';
import { ThreadsAdapter } from './threads-adapter';
import { VaultWikiStore } from './vault-store';
import { BudgetScheduler } from './scheduler';
import { JobQueue } from './jobs';
import { evaluateCandidate } from './evaluation';
import { loadEvaluationContract } from './playbook';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const VIEW_TYPE = 'geode-wikiskill:dashboard';
interface WorkspaceExternalEvents { on(name: string, callback: () => void): EventRef }

export default class WikiSkillPlugin extends Plugin {
  state: PluginState = defaultState();
  private readonly hostEvents = new EventTarget();
  private adapter!: ThreadsAdapter;
  private importedCount = 0;
  private redactions = 0;
  private activeCancel?: () => Promise<void>;
  private scheduler!: BudgetScheduler;
  private queue!: JobQueue;

  async onload(): Promise<void> {
    this.state = migrateState(await this.loadData());
    this.importedCount = this.state.evidence.length;
    this.scheduler = new BudgetScheduler(this.state.settings.dailyTokenBudget);
    const workspace = this.app.workspace as unknown as WorkspaceExternalEvents;
    this.registerEvent(workspace.on('claude-threads:api-ready', () => { this.hostEvents.dispatchEvent(new Event('claude-threads:api-ready')); void this.reconcileProvider(); }));
    this.registerEvent(workspace.on('claude-threads:api-stopping', () => { this.hostEvents.dispatchEvent(new Event('claude-threads:api-stopping')); void this.refresh(); }));
    this.adapter = new ThreadsAdapter(() => (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.['claude-threads'], this.hostEvents);
    this.adapter.start();
    this.queue = new JobQueue(this.adapter, cancel => { this.activeCancel = cancel; }, this.state.jobs, () => this.persist());
    this.registerView(VIEW_TYPE, leaf => new WikiSkillView(leaf, () => this.dashboardModel(), action => void this.handleAction(action)));
    this.addRibbonIcon('network', 'Open WikiSkill Evolution', () => void this.openDashboard());
    this.addCommand({ id: 'open-dashboard', name: 'Open WikiSkill Evolution dashboard', callback: () => void this.openDashboard() });
    this.addCommand({ id: 'import-evidence', name: 'Import consented Agent Threads evidence', callback: () => void this.importEvidence() });
    this.addCommand({ id: 'compile-patterns', name: 'Compile imported evidence into patterns', callback: () => void this.compile() });
    this.addCommand({ id: 'propose-candidate', name: 'Propose an integration-routing candidate', callback: () => void this.propose() });
    this.addCommand({ id: 'evaluate-candidate', name: 'Evaluate the latest candidate', callback: () => void this.evaluateLatest() });
    this.addCommand({ id: 'retry-last-job', name: 'Retry the last failed operation', callback: () => void this.retry() });
    this.addSettingTab(new WikiSkillSettings(this.app, this));
    this.registerInterval(window.setInterval(() => void this.runScheduledCycle(), 15 * 60 * 1000));
  }
  onunload(): void { this.adapter.stop(); }

  async persist(): Promise<void> { await this.saveData(this.state); await new VaultWikiStore(this.app.vault).write(this.state); await this.refresh(); }
  async importEvidence(): Promise<void> {
    try {
      const storage = (this.app as unknown as { secretStorage?: { getSecret(id: string): string | null } }).secretStorage;
      if (!storage) throw new Error('Secure secret storage is unavailable; trace import is blocked');
      const secrets = this.state.settings.secretIds.map(id => storage.getSecret(id));
      if (secrets.some(value => value === null)) throw new Error('A configured redaction secret is unavailable; trace import is blocked');
      const importer = new TraceImporter(this.adapter, new Set(this.state.consentedProjects), secrets as string[]);
      const result = await importer.prepareBatch(this.state.sourceCheckpoints, this.state.settings.importLimit);
      const importedAt = new Date().toISOString();
      const incoming = result.events.map(event => ({ id: event.id, skill: event.skill!, action: event.text, outcome: event.outcome, importedAt }));
      const known = new Set(this.state.evidence.map(item => item.id));
      this.state.evidence.push(...incoming.filter(item => !known.has(item.id)));
      this.state.sourceCheckpoints = result.checkpoints;
      this.importedCount += result.events.length; this.redactions += result.redactions;
      await this.persist(); new Notice(`Imported ${result.events.length} eligible event(s).`);
    } catch (error) { new Notice(error instanceof Error ? error.message : 'Import failed'); }
  }
  async compile(): Promise<void> { this.state.patterns = compilePatterns(this.state.evidence); await this.persist(); new Notice(`Compiled ${this.state.patterns.length} pattern(s).`); }
  async propose(): Promise<void> {
    if (this.adapter.status !== 'full') return void new Notice('Agent Threads authoring capability is unavailable.');
    const evidence = this.state.patterns.filter(pattern => pattern.skill === 'integration-routing').map(pattern => `${pattern.action}\nCounterexamples: ${pattern.counterexamples.join(', ')}`).join('\n\n');
    if (!evidence) return void new Notice('Compile integration-routing evidence before proposing.');
    try { const candidate = await this.queue.propose('integration-routing', evidence); this.state.candidates.push(candidate); await this.persist(); new Notice('Created one isolated candidate for review.'); }
    catch (error) { await this.recordFailure('propose', error); }
  }
  async evaluateLatest(): Promise<void> {
    const candidate = [...this.state.candidates].reverse().find(item => item.status === 'draft');
    if (!candidate) return void new Notice('No draft candidate is available.');
    const { evaluationManifestPath, canonicalSkillPath } = this.state.settings;
    if (!evaluationManifestPath || !canonicalSkillPath) return void new Notice('Configure the Playbook manifest and canonical skill paths first.');
    try {
      const jobId = `evaluate-${candidate.id}`; let job = this.state.jobs.find(item => item.id === jobId); if (!job) { job = { id: jobId, type: 'evaluate', skill: candidate.skill, status: 'queued', idempotencyKey: jobId, evidenceHash: candidate.sourceHash }; this.state.jobs.push(job); } job.status = 'running'; job.error = undefined; await this.persist();
      const contract = await loadEvaluationContract(evaluationManifestPath);
      if (contract.manifest.skillId !== candidate.skill) throw new Error('Candidate skill ID does not match evaluation contract');
      const configuredSkillHash = createHash('sha256').update(await readFile(canonicalSkillPath)).digest('hex');
      if (configuredSkillHash !== contract.manifest.source.hash) throw new Error('Configured canonical skill does not match evaluation contract');
      candidate.sourceHash = contract.manifest.source.hash; candidate.purposeHash = contract.manifest.source.purposeHash; candidate.contractHash = contract.contractHash; candidate.fixtureHashes = Object.fromEntries(contract.fixtures.map(entry => [entry.fixture.id, entry.hash]));
      const result = await evaluateCandidate(this.adapter, contract, candidate.content, cancel => { this.activeCancel = cancel; });
      candidate.status = result.decision === 'reject' ? 'rejected' : 'review';
      this.state.evaluations.push({ id: `eval-${candidate.id}`, candidateId: candidate.id, decision: result.decision, baselineScore: result.baseline.score, candidateScore: result.candidate.score, failures: result.candidate.failures, promoted: false, createdAt: new Date().toISOString(), canonicalSkillHash: candidate.sourceHash, purposeHash: candidate.purposeHash, contractHash: candidate.contractHash, fixtureHashes: candidate.fixtureHashes, evidenceHash: candidate.evidenceHash });
      job.status = 'complete'; job.outputHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
      await this.persist(); new Notice(result.decision === 'review' ? 'Evaluation passed; human review is required.' : `Candidate rejected: ${result.reason}`);
    } catch (error) { const job = this.state.jobs.find(item => item.id === `evaluate-${candidate.id}`); if (job) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Evaluation failed'; await this.persist(); } new Notice(error instanceof Error ? error.message : 'Evaluation failed'); }
  }
  async retry(): Promise<void> { const last = [...this.state.jobs].reverse().find(job => job.status === 'failed'); if (!last) return void new Notice('No failed operation to retry.'); if (last.type === 'proposer-v1') { const evidence = this.state.patterns.filter(pattern => pattern.skill === last.skill).map(pattern => pattern.action).join('\n'); const candidate = await this.queue.propose(last.skill, evidence, last.id); if (!this.state.candidates.some(item => item.id === candidate.id)) this.state.candidates.push(candidate); await this.persist(); } else await this.evaluateLatest(); }
  async cancel(): Promise<void> { if (!this.activeCancel) return void new Notice('No authoring or evaluation run is active.'); try { await this.activeCancel(); const running = [...this.state.jobs].reverse().find(job => job.status === 'running'); if (running) running.status = 'cancelled'; await this.persist(); new Notice('Cancellation requested.'); } finally { this.activeCancel = undefined; } }
  private async handleAction(action: string): Promise<void> { if (action === 'import-evidence') await this.importEvidence(); else if (action === 'compile-patterns') await this.compile(); else if (action === 'propose-candidate') await this.propose(); else if (action === 'evaluate') await this.evaluateLatest(); else if (action === 'cancel') await this.cancel(); else if (action === 'retry') await this.retry(); }
  private async recordFailure(type: string, error: unknown): Promise<void> { const message = error instanceof Error ? error.message : `${type} failed`; new Notice(message); }
  private async runScheduledCycle(): Promise<void> { if (this.adapter.status !== 'full') return; await this.scheduler.run('integration-routing', this.state.settings.importLimit * 20, async () => { const before = this.state.evidence.length; await this.importEvidence(); if (this.state.evidence.length === before) return undefined; const corpus = this.state.evidence.filter(item => item.skill === 'integration-routing').map(item => `${item.id}: ${item.action}`).join('\n'); this.state.patterns = await this.queue.maintain('integration-routing', corpus); this.applyRetention(); await this.persist(); return true; }); }
  private applyRetention(): void { const cutoff = Date.now() - this.state.settings.retentionDays * 86400000; this.state.evidence = this.state.evidence.filter(item => !item.importedAt || Date.parse(item.importedAt) >= cutoff); this.state.candidates = this.state.candidates.filter(item => Date.parse(item.createdAt) >= cutoff || item.status === 'review'); this.state.evaluations = this.state.evaluations.filter(item => Date.parse(item.createdAt) >= cutoff || item.decision === 'review'); }
  private dashboardModel(): DashboardModel { return { status: this.adapter.status, imported: this.importedCount, redactions: this.redactions, patterns: this.state.patterns, candidates: this.state.candidates, evaluations: this.state.evaluations }; }
  private async openDashboard(): Promise<void> { const leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return; await leaf.setViewState({ type: VIEW_TYPE, active: true }); this.app.workspace.revealLeaf(leaf); }
  private async refresh(): Promise<void> { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof WikiSkillView) leaf.view.render(); }
  private async reconcileProvider(): Promise<void> { if (this.queue?.reconcileInterrupted()) await this.persist(); else await this.refresh(); }
}

class WikiSkillView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly model: () => DashboardModel, private readonly action: (name: string) => void) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'WikiSkill Evolution'; }
  getIcon(): string { return 'network'; }
  async onOpen(): Promise<void> { this.render(); }
  render(): void { this.contentEl.innerHTML = renderDashboard(this.model()); for (const button of Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-action]'))) button.addEventListener('click', () => this.action(button.dataset.action ?? '')); for (const button of Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-section]'))) button.addEventListener('click', () => this.contentEl.querySelector(`#wikiskill-${button.dataset.section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
}

class WikiSkillSettings extends PluginSettingTab {
  constructor(app: WikiSkillPlugin['app'], private readonly plugin: WikiSkillPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty(); this.containerEl.createEl('h2', { text: 'WikiSkill Evolution' });
    this.containerEl.createEl('p', { text: 'Only explicitly consented project IDs are imported. Separate multiple IDs with commas.' });
    new Setting(this.containerEl).setName('Consented project IDs').setDesc('No projects are enabled by default.').addText(text => text.setValue(this.plugin.state.consentedProjects.join(', ')).onChange(async value => { this.plugin.state.consentedProjects = value.split(',').map(item => item.trim()).filter(Boolean); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName('Knowledge output folder').addText(text => text.setValue(this.plugin.state.settings.outputRoot).onChange(async value => { const path = value.trim(); if (!path || path.startsWith('/') || path.split('/').includes('..')) return void new Notice('Output folder must be a contained vault-relative path.'); this.plugin.state.settings.outputRoot = path; await this.plugin.persist(); }));
    new Setting(this.containerEl).setName('Playbook evaluation manifest').setDesc('Absolute path to the governed manifest.json.').addText(text => text.setValue(this.plugin.state.settings.evaluationManifestPath).onChange(async value => { this.plugin.state.settings.evaluationManifestPath = value.trim(); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName('Canonical skill file').setDesc('Absolute path used for stale-hash verification.').addText(text => text.setValue(this.plugin.state.settings.canonicalSkillPath).onChange(async value => { this.plugin.state.settings.canonicalSkillPath = value.trim(); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName('Redaction secret IDs').setDesc('Comma-separated IDs in Geode Secret Storage. Secret values are never persisted by WikiSkill.').addText(text => text.setValue(this.plugin.state.settings.secretIds.join(', ')).onChange(async value => { this.plugin.state.settings.secretIds = value.split(',').map(item => item.trim()).filter(Boolean); await this.plugin.persist(); }));
  }
}
