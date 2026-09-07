import type { Candidate, EvaluationRecord, Pattern } from './model';
import type { DependencyStatus } from './threads-adapter';

export interface DashboardModel { status: DependencyStatus; imported: number; redactions: number; patterns: Pattern[]; candidates: Candidate[]; evaluations: EvaluationRecord[] }
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function renderDashboard(model: DashboardModel): string {
  const status = model.status === 'full' ? 'Connected' : model.status === 'read-only' ? 'Read only' : 'Offline';
  const cards = [
    ['Dependency', `${status} · Agent Threads`],
    ['Import', `${model.imported} evidence events · ${model.redactions} redactions`],
    ['Patterns', model.patterns.length ? model.patterns.map(p => `${escape(p.action)} (${p.confidence})`).join('<br>') : 'No compiled patterns'],
    ['Candidates', model.candidates.length ? `${model.candidates.length} isolated proposal(s)` : 'No candidates'],
    ['Evaluations', model.evaluations.length ? `${model.evaluations.length} completed` : 'No evaluations'],
    ['Review', model.candidates.some(c => c.status === 'review') ? 'Human review required' : 'Nothing awaiting review']
  ];
  const actions = ['Import evidence', 'Compile patterns', 'Propose candidate', 'Evaluate', 'Cancel', 'Retry'];
  return `<div class="wikiskill-shell"><header><p class="eyebrow">AGENT KNOWLEDGE</p><h1>WikiSkill Evolution</h1><p>Evidence becomes reviewable skill improvements—never automatic changes.</p><span class="status status-${model.status}">${status}</span></header><nav>${cards.map(([title]) => `<button type="button">${title}</button>`).join('')}</nav><div class="wikiskill-actions">${actions.map(action => `<button type="button" data-action="${action.toLowerCase().replace(/ /g, '-')}">${action}</button>`).join('')}</div><main>${cards.map(([title, body]) => `<section><h2>${title}</h2><p>${body}</p></section>`).join('')}</main></div>`;
}
