export class BudgetScheduler {
  private locks = new Set<string>();
  private used = 0;
  constructor(private readonly dailyBudget: number) {}
  async run<T>(scope: string, estimatedTokens: number, work: () => Promise<T | undefined>): Promise<{ status: 'complete' | 'skipped'; value?: T }> {
    if (this.locks.has(scope) || this.used + estimatedTokens > this.dailyBudget) return { status: 'skipped' };
    this.locks.add(scope);
    try { const value = await work(); if (value === undefined) return { status: 'skipped' }; this.used += estimatedTokens; return { status: 'complete', value }; }
    finally { this.locks.delete(scope); }
  }
}
