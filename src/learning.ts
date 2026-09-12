import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence, Pattern } from './model';
import type { PluginState } from './state';
import { redactTrace } from './privacy';
import { resolveAttribution } from './local-integration';
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface InstalledSkill {
    localSkillId?: string;
    vaultPackagePath?: string;
    id: string;
    name: string;
    path: string;
    hash: string;
    content: string;
}
interface DiscoveryIO {
    list(root: string): Promise<string[]>;
    read(path: string): Promise<string>;
}
export async function skillFiles(root: string): Promise<string[]> {
    const visited = new Set<string>();
    const found: string[] = [];
    let entries = 0;
    async function walk(path: string, depth: number): Promise<void> {
        if (depth > 8 || entries >= 5000 || found.length >= 500)
            return;
        let canonical: string;
        try {
            canonical = await realpath(path);
        }
        catch {
            return;
        }
        if (visited.has(canonical))
            return;
        visited.add(canonical);
        let children;
        try {
            children = await readdir(path, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const child of children) {
            if (++entries > 5000)
                break;
            if (['node_modules', '.git'].includes(child.name))
                continue;
            const next = join(path, child.name);
            if (child.name === 'SKILL.md') {
                try {
                    found.push(await realpath(next));
                }
                catch {
                    continue;
                }
            }
            else if (child.isDirectory() || child.isSymbolicLink())
                await walk(next, depth + 1);
        }
    }
    await walk(root, 0);
    return found.sort();
}
export async function discoverSkills(roots: string[], io: DiscoveryIO = { list: skillFiles, read: async (p) => { if ((await stat(p)).size > 131072)
        throw new Error('Skill too large'); return readFile(p, 'utf8'); } }, secrets: string[] = []): Promise<InstalledSkill[]> {
    const result = new Map<string, InstalledSkill>();
    for (const root of roots)
        for (const path of await io.list(root)) {
            try {
                const raw = await io.read(path);
                const name = raw.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() ?? path.split('/').at(-2) ?? 'skill';
                const id = hash(path).slice(0, 24);
                result.set(id, { id, name, path, hash: hash(raw), content: redactTrace(raw, secrets).text });
            }
            catch { /* Unreadable/oversized skills are never partially ingested. */ }
        }
    return [...result.values()];
}
export async function scanDocuments(state: PluginState, files: Array<{
    path: string;
    size: number;
}>, read: (path: string) => Promise<string>, secrets: string[] = []): Promise<void> {
    state.vaultScan.outputRoots = [...new Set([...state.vaultScan.outputRoots, state.settings.outputRoot])];
    const excluded = [...state.vaultScan.outputRoots, ...state.settings.exclusions, ...state.skills.flatMap(s=>s.vaultPackagePath?[s.vaultPackagePath]:[]), state.settings.authoredSkillFolder, '.agents', '.claude', '.codex', '.geode', '.obsidian', '.git'];
    const eligible = files.filter(f => !excluded.some(p => f.path === p || f.path.startsWith(p.replace(/\/$/, '') + '/')) && f.size <= 262144).sort((a, b) => a.path.localeCompare(b.path));
    const present = new Set(eligible.map(f => f.path));
    state.evidence = state.evidence.filter(e => !e.sourcePath || present.has(e.sourcePath));
    for (const p of Object.keys(state.vaultScan.hashes))
        if (!present.has(p))
            delete state.vaultScan.hashes[p];
    let count = 0, bytes = 0;
    for (const file of eligible.filter(f => !state.vaultScan.cursor || f.path > state.vaultScan.cursor)) {
        if (count >= state.settings.importLimit || bytes + file.size > 1048576) {
            state.evidence = state.evidence.slice(-10000);
            return;
        }
        const raw = await read(file.path);
        bytes += Buffer.byteLength(raw);
        count++;
        state.importProgress.scannedSources++;
        state.importProgress.scannedBytes += Buffer.byteLength(raw);
        if (Buffer.byteLength(raw) > 262144) {
            state.vaultScan.cursor = file.path;
            continue;
        }
        const digest = hash(raw);
        if (state.vaultScan.hashes[file.path] !== digest) {
            state.evidence = state.evidence.filter(e => e.sourcePath !== file.path);
            const clean = redactTrace(raw, secrets);
            state.importProgress.redactions += clean.redactions;
            // Generated packets carry a stable marker even if moved outside the output root.
            if (!clean.text.includes('wikiskill-generated'))
                for (const [line, text] of clean.text.split('\n').entries()) {
                    const failure = /\b(fail(?:ed|ure)?|error|timeout|workaround|incorrect|unnecessary|retry|correction)\b/i.test(text);
                    const success = /\b(success(?:ful(?:ly)?)?|worked|resolved)\b/i.test(text) && !/\b(failed|error|incorrect)\b/i.test(text);
                    if (!failure && !success)
                        continue;
                    const qualified=[...new Set(text.match(/\blocal:([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)??[])];
                    const matched = qualified.length ? qualified.flatMap(name=>{const skill=resolveAttribution(name,state.skills);return skill?[skill]:[];}) : state.skills.filter(s => new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
                    state.evidence.push({ id: `vault-${hash(file.path + ':' + line).slice(0, 24)}`, skill: matched.length === 1 ? matched[0]!.id : 'unmapped', action: text.slice(0, 2000), outcome: success ? 'success' : 'failure', sourcePath: file.path, sourceLine: line + 1, sourceHash: digest, inferred: true, importedAt: new Date().toISOString() });
                }
            state.vaultScan.hashes[file.path] = digest;
        }
        state.vaultScan.cursor = file.path;
    }
    state.vaultScan.cursor = undefined;
    state.evidence = state.evidence.slice(-10000);
}
export function compileFrictions(evidence: Evidence[]): Pattern[] {
    const groups = new Map<string, Evidence[]>();
    for (const e of evidence) {
        const key = e.skill + '|' + theme(e.action);
        groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups].flatMap(([key, items]) => {
        const skill = items[0]!.skill;
        const failures = items.filter(e => e.outcome === 'failure'), successes = items.filter(e => e.outcome === 'success');
        if (!failures.length)
            return [];
        const sources = new Set(failures.map(e => e.sourcePath ?? e.id)).size;
        return [{ id: `friction-${hash(key).slice(0, 16)}`, skill, action: failures[0]!.action, confidence: sources >= 2 ? 'medium' : 'weak', evidence: failures.map(e => e.id), counterexamples: successes.map(e => e.id), updatedAt: new Date().toISOString() } as Pattern];
    });
}
function theme(text: string): string {
    const specific = text.toLowerCase().match(/timeout|permission|authentication|formatting|approval|missing|syntax|network/);
    return specific?.[0] ?? text.toLowerCase().replace(/\b(failed|failure|error|successfully|success|worked|resolved|due|to)\b/g, '').replace(/\s+/g, ' ').trim();
}
export function reviewCandidate(state: PluginState, id: string, status: 'approved' | 'dismissed' | 'deferred'): void {
    const candidate = state.candidates.find(c => c.id === id);
    if (!candidate)
        throw new Error('Candidate not found');
    if (status === 'approved' && candidate.sourceHash && state.skills.find(s => s.id === candidate.skill)?.hash !== candidate.sourceHash)
        throw new Error('Skill source changed; generate a new proposal');
    candidate.status = status;
}
