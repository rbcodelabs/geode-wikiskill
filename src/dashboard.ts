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
    ['Candidates', model.candidates.length ? model.candidates.map(c => `${escape(c.id)} — ${c.status}`).join('<br>') : 'No candidates'],
    ['Evaluations', model.evaluations.length ? model.evaluations.map(e => `${escape(e.candidateId)} — ${e.decision} (${e.baselineScore.toFixed(2)} → ${e.candidateScore.toFixed(2)})`).join('<br>') : 'No evaluations'],
    ['Review', model.candidates.filter(c => c.status === 'review').map(c => `${escape(c.id)} — human review required`).join('<br>') || 'Nothing awaiting review']
  ];
  const actions = ['Import evidence', 'Compile patterns', 'Propose candidate', 'Evaluate', 'Cancel', 'Retry'];
  return `<div class="wikiskill-shell"><header><p class="eyebrow">AGENT KNOWLEDGE</p><h1>WikiSkill Evolution</h1><p>Evidence becomes reviewable skill improvements—never automatic changes.</p><span class="status status-${model.status}">${status}</span></header><nav>${cards.map(([title]) => `<button type="button" data-section="${title.toLowerCase()}">${title}</button>`).join('')}</nav><div class="wikiskill-actions">${actions.map(action => `<button type="button" data-action="${action.toLowerCase().replace(/ /g, '-')}">${action}</button>`).join('')}</div><main>${cards.map(([title, body]) => `<section id="wikiskill-${title.toLowerCase()}"><h2>${title}</h2><p>${body}</p></section>`).join('')}</main></div>`;
}
