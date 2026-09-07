export class BudgetScheduler {
  private locks = new Set<string>();
  constructor(
    private readonly dailyBudget: number,
    private readonly budget: { utcDay: string; usedTokens: number } = {
      utcDay: "",
      usedTokens: 0,
    },
    private readonly now: () => Date = () => new Date(),
    private readonly persist: () => Promise<void> = async () => undefined,
  ) {}
  async run<T>(
    scope: string,
    estimatedTokens: number,
    work: () => Promise<T | undefined>,
  ): Promise<{ status: "complete" | "skipped"; value?: T }> {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.budget.utcDay) {
      this.budget.utcDay = today;
      this.budget.usedTokens = 0;
      await this.persist();
    }
    if (
      this.locks.has(scope) ||
      this.budget.usedTokens + estimatedTokens > this.dailyBudget
    )
      return { status: "skipped" };
    this.locks.add(scope);
    this.budget.usedTokens += estimatedTokens;
    try {
      await this.persist();
    } catch (error) {
      this.budget.usedTokens -= estimatedTokens;
      this.locks.delete(scope);
      throw error;
    }
    try {
      const value = await work();
      if (value === undefined) {
        this.budget.usedTokens -= estimatedTokens;
        await this.persist();
        return { status: "skipped" };
      }
      return { status: "complete", value };
    } finally {
      this.locks.delete(scope);
    }
  }
}
