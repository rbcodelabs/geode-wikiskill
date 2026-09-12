import { describe, it, expect, vi } from 'vitest';
import { hash } from '../src/learning';
import { FakeThreadsApi } from './support/fake-threads';
vi.mock('obsidian', () => ({
    Plugin: class {
        app: unknown;
        constructor(app: unknown) { this.app = app; }
        async loadData() { return null; }
        async saveData() { }
        registerEvent() { }
        registerView() { }
        addRibbonIcon() { }
        addCommand() { }
        addSettingTab() { }
        registerInterval() { }
    },
    PluginSettingTab: class {
    }, ItemView: class {
    }, Notice: class {
    },
    TFile: class {
    }, normalizePath: (p: string) => p,
}));
import WikiSkillPlugin from '../src/main';
describe('installed plugin learning flow', () => {
    it('scans non-PM evidence then proposes through visible conversations, reviews, exports and rejects stale sources', async () => {
        vi.stubGlobal('window', { setInterval: () => 1 });
        const api = new FakeThreadsApi();
        const files = [{ path: 'activity.md', stat: { size: 100 } }];
        let text = 'export failed due to timeout';
        const exported=new Map<string,string>();
        const app = { vault: { configDir: '.geode', adapter: {}, getAbstractFileByPath:()=>undefined,createFolder:async()=>{},create:async(path:string,content:string)=>{exported.set(path,content);},getMarkdownFiles: () => files, getFileByPath: (p: string) => files.find(f => f.path === p), read: async () => text }, workspace: { on: () => ({}), getLeavesOfType: () => [] }, plugins: { plugins: { 'claude-threads': { api: { v1: api } } } } };
        const plugin = new WikiSkillPlugin(app as never, {} as never);
        await plugin.onload();
        const skill = { id: 'export-id', name: 'export', path: '/synthetic/SKILL.md', hash: hash('old guidance'), content: 'old guidance' };
        vi.spyOn(plugin, 'discover').mockImplementation(async () => { plugin.state.skills = [{ ...skill }]; });
        await plugin.scanVault();
        expect(plugin.state.patterns).toHaveLength(1);
        const ordinary = vi.spyOn(api.threads, 'create');
        await plugin.propose();
        expect(ordinary).toHaveBeenCalledTimes(1);
        const open=vi.spyOn(api.threads,'open');await plugin.openJobThread(plugin.state.jobs[0]!.id);expect(open).toHaveBeenCalledWith(plugin.state.jobs[0]!.externalThreadId);
        expect(plugin.state.candidates).toHaveLength(1);
        const candidate = plugin.state.candidates[0]!;
        expect(candidate.sourceEvidence?.[0]?.hash).toBe(hash(text));
        await plugin.review(candidate.id, 'deferred');
        await plugin.propose();
        expect(plugin.state.candidates).toHaveLength(1);
        plugin.state.settings.scenarioJson = '[{"id":"format","prompt":"Return JSON","expected":"{\\"ok\\":true}"}]';
        await plugin.evaluateLatest();
        expect(plugin.state.evaluations).toHaveLength(1);
        await plugin.review(candidate.id, 'approved');
        await (plugin as unknown as {exportPackets():Promise<void>}).exportPackets();
        expect([...exported].some(([path,content])=>path.includes('/approved/')&&content.includes('candidate improvement'))).toBe(true);
        expect([...exported.keys()].every(path=>path.startsWith(plugin.state.settings.outputRoot+'/'))).toBe(true);
        text = 'export failed due to timeout again';
        await expect(plugin.review(candidate.id, 'approved')).rejects.toThrow(/Evidence source changed/);
        await plugin.scanVault();
        await plugin.propose();
        expect(plugin.state.candidates).toHaveLength(2);
        expect(plugin.state.candidates[1]?.patternSignature).not.toBe(candidate.patternSignature);
        plugin.onunload();
        vi.unstubAllGlobals();
    });
    it('retains local scanning when the execution provider is missing',async()=>{
        vi.stubGlobal('window',{setInterval:()=>1});
        const file={path:'friction.md',size:40};
        const app={vault:{adapter:{},getMarkdownFiles:()=>[file],read:async()=> 'A repeated network timeout failed'},workspace:{on:()=>({}),getLeavesOfType:()=>[]}};
        const plugin=new WikiSkillPlugin(app as never,{} as never);await plugin.onload();
        vi.spyOn(plugin,'discover').mockResolvedValue();
        await plugin.scanVault();await plugin.propose();
        expect(plugin.state.evidence).toHaveLength(1);expect(plugin.state.candidates).toHaveLength(0);
        plugin.onunload();vi.unstubAllGlobals();
    });
});
