// Task budgets: an agent names a task and gives it a dollar budget once; every request under that name draws from
// it, and the router refuses the next request when the budget is spent. With a path the book is kept on disk, so a
// restarted router still knows what each job has spent; tasks untouched for a week are dropped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export type Task = { budget: bigint; spent: bigint; answers: number; firstAt: number; lastAt: number };

const NAME = /^[A-Za-z0-9._:\-]{1,64}$/;
const IDLE_MS = 7 * 86_400_000;

export class TaskBook {
  private tasks = new Map<string, Task>();

  constructor(private max = 1_000, private path: string | null = null, now = Date.now()) {
    if (!path || !existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { budget: string; spent: string; answers: number; firstAt: number; lastAt: number }>;
      for (const [name, t] of Object.entries(raw)) if (now - t.lastAt < IDLE_MS) this.tasks.set(name, { budget: BigInt(t.budget), spent: BigInt(t.spent), answers: t.answers, firstAt: t.firstAt, lastAt: t.lastAt });
    } catch {
      // An unreadable book starts empty; a budget is then set again by the next request that names one.
    }
  }

  private save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries([...this.tasks.entries()].map(([n, t]) => [n, { budget: t.budget.toString(), spent: t.spent.toString(), answers: t.answers, firstAt: t.firstAt, lastAt: t.lastAt }])), null, 1));
    } catch {
      // Keeping the book on disk is a convenience; a request is never held back because it could not be written.
    }
  }

  /** Opens the task or picks it up, and returns what is left. A budget sent later can lower the first one, never raise it. */
  open(name: string, budget: bigint | null, now = Date.now()): { left: bigint; task: Task } {
    if (!NAME.test(name)) throw new Error('a task name is 1 to 64 letters, digits, dots, dashes, colons or underscores');
    let t = this.tasks.get(name);
    if (!t) {
      if (budget === null) throw new Error(`task ${name} has no budget yet; send x-orrery-task-budget with its first request`);
      if (this.tasks.size >= this.max) this.tasks.delete(this.tasks.keys().next().value as string);
      t = { budget, spent: 0n, answers: 0, firstAt: now, lastAt: now };
      this.tasks.set(name, t);
      this.save();
    } else if (budget !== null && budget < t.budget) {
      t.budget = budget;
      this.save();
    }
    return { left: t.budget > t.spent ? t.budget - t.spent : 0n, task: t };
  }

  spend(name: string, units: bigint, now = Date.now()): Task | null {
    const t = this.tasks.get(name);
    if (!t) return null;
    t.spent += units;
    t.answers += 1;
    t.lastAt = now;
    this.save();
    return t;
  }

  list(): (Task & { name: string })[] {
    return [...this.tasks.entries()].map(([name, t]) => ({ name, ...t })).reverse();
  }
}
