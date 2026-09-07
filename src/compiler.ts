import type { Evidence, Pattern } from './model';

export function compilePatterns(items: readonly Evidence[], now = new Date().toISOString()): Pattern[] {
  const grouped = new Map<string, Evidence[]>();
  for (const item of items) {
    const key = `${item.skill}\0${normalize(item.action)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const patterns: Pattern[] = [];
  for (const [key, group] of grouped) {
    const successes = group.filter(item => item.outcome === 'success');
    const failures = group.filter(item => item.outcome === 'failure');
    if (successes.length === 0 && failures.length === 0) continue;
    const exemplar = group[0]!;
    patterns.push({
      id: stableId(key), skill: exemplar.skill, action: exemplar.action,
      confidence: successes.length >= 3 ? 'strong' : successes.length >= 2 ? 'medium' : 'weak',
      evidence: successes.map(item => item.id), counterexamples: failures.map(item => item.id), updatedAt: now
    });
  }
  return patterns.sort((a, b) => b.evidence.length - a.evidence.length);
}

function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function stableId(value: string): string { let hash = 2166136261; for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); return `pattern-${(hash >>> 0).toString(16)}`; }
