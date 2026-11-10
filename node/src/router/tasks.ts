// Task budgets: an agent names a task and gives it a dollar budget once; every request under that name draws from
// it, and the router refuses the next request when the budget is spent. Kept in memory for the life of the router.
export type Task = { budget: bigint; spent: bigint; answers: number; firstAt: number; lastAt: number };

const NAME = /^[A-Za-z0-9._:\-]{1,64}$/;

export class TaskBook {
  private tasks = new Map<string, Task>();

  constructor(private max = 1_000) {}

  /** Opens the task or picks it up, and returns what is left. A budget sent later can lower the first one, never raise it. */
  open(name: string, budget: bigint | null, now = Date.now()): { left: bigint; task: Task } {
    if (!NAME.test(name)) throw new Error('a task name is 1 to 64 letters, digits, dots, dashes, colons or underscores');
    let t = this.tasks.get(name);
    if (!t) {
      if (budget === null) throw new Error(`task ${name} has no budget yet; send x-orrery-task-budget with its first request`);
      if (this.tasks.size >= this.max) this.tasks.delete(this.tasks.keys().next().value as string);
      t = { budget, spent: 0n, answers: 0, firstAt: now, lastAt: now };
      this.tasks.set(name, t);
    } else if (budget !== null && budget < t.budget) t.budget = budget;
    return { left: t.budget > t.spent ? t.budget - t.spent : 0n, task: t };
  }

  spend(name: string, units: bigint, now = Date.now()): Task | null {
    const t = this.tasks.get(name);
    if (!t) return null;
    t.spent += units;
    t.answers += 1;
    t.lastAt = now;
    return t;
  }

  list(): (Task & { name: string })[] {
    return [...this.tasks.entries()].map(([name, t]) => ({ name, ...t })).reverse();
  }
}
