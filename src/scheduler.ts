export class BudgetScheduler {
  private locks = new Set<string>();
  private used = 0;
  private budgetDay = '';
  constructor(private readonly dailyBudget: number, private readonly now: () => Date = () => new Date()) {}
  async run<T>(scope: string, estimatedTokens: number, work: () => Promise<T | undefined>): Promise<{ status: 'complete' | 'skipped'; value?: T }> {
    const today = this.now().toISOString().slice(0, 10); if (today !== this.budgetDay) { this.budgetDay = today; this.used = 0; }
    if (this.locks.has(scope) || this.used + estimatedTokens > this.dailyBudget) return { status: 'skipped' };
    this.locks.add(scope);
    try { const value = await work(); if (value === undefined) return { status: 'skipped' }; this.used += estimatedTokens; return { status: 'complete', value }; }
    finally { this.locks.delete(scope); }
  }
}
