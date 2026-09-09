import { describe, it, expect } from 'vitest';
import { scanDocuments, discoverSkills, compileFrictions, reviewCandidate } from '../src/learning';
import { defaultState, migrateState } from '../src/state';
import { evaluateScenarios, parseScenarios } from '../src/scenarios';
import { FakeThreadsApi } from './support/fake-threads';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('self-contained learning', () => {
    it('discovers same-name filesystem skills independently and deduplicates symlink aliases safely',async()=>{
        const root=await mkdtemp(join(tmpdir(),'wikiskill-discovery-'));
        try {
            await mkdir(join(root,'one'));await mkdir(join(root,'two'));
            await writeFile(join(root,'one','SKILL.md'),'---\nname: export\n---\nprivate-value');
            await writeFile(join(root,'two','SKILL.md'),'---\nname: export\n---\nOther guidance');
            await symlink(join(root,'one'),join(root,'alias'));
            await symlink(root,join(root,'one','cycle'));
            const skills=await discoverSkills([root],undefined,['private-value']);
            expect(skills).toHaveLength(2);expect(new Set(skills.map(s=>s.id)).size).toBe(2);
            expect(skills.map(s=>s.content).join('')).not.toContain('private-value');
        } finally {await rm(root,{recursive:true,force:true});}
    });
    it('runs independent WikiSkill-owned scenarios on baseline and candidate without package contracts', async () => {
        const api = new FakeThreadsApi();
        const scenarios = parseScenarios('[{"id":"format","prompt":"Return JSON","expected":"{\\"ok\\":true}"}]');
        const result = await evaluateScenarios(api, 'old guidance', 'candidate improvement', scenarios);
        expect(result.baselineScore).toBe(0);
        expect(result.candidateScore).toBe(1);
        expect(() => parseScenarios('[]')).toThrow(/scenario/);
    });
    it('discovers a non-PM skill and links repeated friction with provenance and counterevidence', async () => {
        const skills = await discoverSkills(['/skills'], { list: async () => ['/skills/export/SKILL.md'], read: async () => '---\nname: export\n---\nExport documents' });
        const state = defaultState();
        state.skills = skills;
        await scanDocuments(state, [{ path: 'a.md', size: 100 }, { path: 'b.md', size: 100 }, { path: 'c.md', size: 100 }], async (p) => p === 'c.md' ? 'export timeout resolved successfully' : 'export failed due to timeout');
        const patterns = compileFrictions(state.evidence);
        expect(patterns[0]?.evidence).toHaveLength(2);
        expect(patterns[0]?.counterexamples).toHaveLength(1);
        expect(patterns[0]?.skill).toBe(skills[0]?.id);
        expect(state.evidence[0]?.sourcePath).toBe('a.md');
        expect(state.evidence[0]?.inferred).toBe(true);
    });
    it('does not combine unrelated failures or successes into evidence of recurrence', () => {
        const patterns = compileFrictions([
            { id: '1', skill: 's', action: 'export timeout failed', outcome: 'failure' },
            { id: '2', skill: 's', action: 'export permission denied', outcome: 'failure' },
            { id: '3', skill: 's', action: 'export formatting worked', outcome: 'success' },
        ]);
        expect(patterns).toHaveLength(2);
        expect(patterns.every(p => p.confidence === 'weak' && p.evidence.length === 1 && p.counterexamples.length === 0)).toBe(true);
    });
    it('resumes bounded scans, excludes own outputs, redacts and removes deleted evidence', async () => {
        const state = defaultState();
        state.settings.importLimit = 1;
        const docs = [{ path: 'a.md', size: 100 }, { path: 'b.md', size: 100 }, { path: state.settings.outputRoot + '/x.md', size: 100 }];
        const read = async () => 'failed export api_key=supersecret';
        await scanDocuments(state, docs, read);
        const restored = migrateState(JSON.parse(JSON.stringify(state)));
        await scanDocuments(restored, docs, read);
        expect(restored.evidence).toHaveLength(2);
        expect(JSON.stringify(restored.evidence)).not.toContain('supersecret');
        await scanDocuments(restored, [], read);
        expect(restored.evidence).toHaveLength(0);
    });
    it('preserves review decisions and rejects stale skill approval', () => {
        const state = defaultState();
        state.skills = [{ id: 's', name: 'export', path: '/skill', hash: 'a'.repeat(64), content: 'export' }];
        state.candidates = [{ id: 'c', skill: 's', content: 'new', sourceHash: 'a'.repeat(64), createdAt: new Date().toISOString(), status: 'review' }];
        reviewCandidate(state, 'c', 'deferred');
        expect(migrateState(state).candidates[0]?.status).toBe('deferred');
        state.skills[0]!.hash = 'b'.repeat(64);
        expect(() => reviewCandidate(state, 'c', 'approved')).toThrow(/changed/);
    });
});
