// `orrery run <client>`: start a coding agent wired to your router, bill the whole session as one job, and print the
// bill when it exits. The agent needs no key of its own: the wallet behind the router is the account.
import { CLI } from './brand.ts';

export const RUNNABLE = ['claude'] as const;
export type Runnable = (typeof RUNNABLE)[number];

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** A name for the job nobody has to think of: the client, the folder it runs in and the time (UTC). It fits the
 * router's rule for task names (letters, digits, `.`, `_`, `:`, `-`, at most 64). */
export function taskName(client: string, cwd: string, now = new Date()): string {
  const folder = (cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'job').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'job';
  const t = now.toISOString();
  return `${client}-${folder}-${t.slice(5, 7)}${t.slice(8, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}`;
}

/** The network model that answers when none was asked for: gpt-oss-120b if the router lists it (the default
 * `orrery connect` uses), else the listed model with the longest context, since a coding agent sends long prompts. */
export function pickModel(models: { id?: string; context_length?: number }[]): string | undefined {
  const listed = models.filter((m): m is { id: string; context_length?: number } => typeof m.id === 'string' && m.id.length > 0);
  if (listed.some((m) => m.id === 'gpt-oss-120b')) return 'gpt-oss-120b';
  return [...listed].sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))[0]?.id;
}

/** What the running router lists, or null when no router answers at that address. */
export async function routerModels(router: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<{ id?: string; context_length?: number }[] | null> {
  try {
    const r = await fetchFn(`${router.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(2_500) });
    if (!r.ok) return null;
    return ((await r.json()) as { data?: { id?: string; context_length?: number }[] }).data ?? [];
  } catch {
    return null;
  }
}

export type RunPlan = { command: string; args: string[]; env: Record<string, string> };

/** The command and environment for a client. For Claude Code: the router as its API, a placeholder key (it will not
 * start without one, and the router ignores it), every request tagged with the task and its budget, and the network
 * model named outright so the router needs no alias. A key or token already in the environment is not passed on. */
export function plan(client: Runnable, o: { router: string; task: string; budget?: string; model: string; args: string[]; env: Record<string, string | undefined> }): RunPlan {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (typeof v === 'string' && k !== 'ANTHROPIC_AUTH_TOKEN' && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  const tags = [`x-orrery-task: ${o.task}`, ...(o.budget ? [`x-orrery-task-budget: ${o.budget}`] : [])];
  const kept = (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').filter((l) => l.trim() && !/^x-orrery-task(-budget)?\s*:/i.test(l.trim()));
  env.ANTHROPIC_BASE_URL = o.router.replace(/\/$/, '');
  env.ANTHROPIC_API_KEY = 'orrery';
  env.ANTHROPIC_CUSTOM_HEADERS = [...kept, ...tags].join('\n');
  env.ANTHROPIC_SMALL_FAST_MODEL = o.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = o.model;
  const asksModel = o.args.some((a) => a === '--model' || a.startsWith('--model='));
  return { command: client, args: asksModel ? o.args : ['--model', o.model, ...o.args], env };
}

export type Bill = { task: string; answers: number; inputTokens: number; outputTokens: number; spent: string; budget?: string };

/** The job's bill from the router's own records: its task book for the money, its log of answers for the tokens. */
export async function readBill(router: string, task: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Bill | null> {
  const base = router.replace(/\/$/, '');
  try {
    const [tr, sr] = await Promise.all([
      fetchFn(`${base}/orrery/tasks`, { signal: AbortSignal.timeout(4_000) }),
      fetchFn(`${base}/orrery/spend?by=task&since=7d`, { signal: AbortSignal.timeout(4_000) }),
    ]);
    const tasks = tr.ok ? ((await tr.json()) as { tasks?: { name: string; budget: string; spent: string; answers: number }[] }).tasks ?? [] : [];
    const rows = sr.ok ? ((await sr.json()) as { rows?: { key: string; answers: number; inputTokens: number; outputTokens: number; usd: string }[] }).rows ?? [] : [];
    const t = tasks.find((x) => x.name === task);
    const r = rows.find((x) => x.key === task);
    if (!t && !r) return { task, answers: 0, inputTokens: 0, outputTokens: 0, spent: '0.000000' };
    return { task, answers: t?.answers ?? r?.answers ?? 0, inputTokens: r?.inputTokens ?? 0, outputTokens: r?.outputTokens ?? 0, spent: t?.spent ?? r?.usd ?? '0.000000', ...(t && Number(t.budget) > 0 ? { budget: t.budget } : {}) };
  } catch {
    return null;
  }
}

export function renderBill(b: Bill | null, task: string): string {
  if (!b) return `${CLI} · ${task}\n  the router did not answer, so there is no bill to show; ${CLI} spend --by task reads it from the log`;
  if (!b.answers) return `${CLI} · ${task}\n  no paid answers in this session`;
  const n = (v: number) => v.toLocaleString('en-US');
  const tokens = b.inputTokens + b.outputTokens;
  // A budget reads as it was given: $0.05, $1.00, and a small one such as $0.001 without being rounded away.
  const [whole, cents = ''] = Number(b.budget ?? 0).toFixed(6).replace(/0+$/, '').split('.');
  const of = b.budget ? ` of $${whole}.${cents.padEnd(2, '0')} budget` : '';
  return [
    `${CLI} · ${task}`,
    `  ${n(b.answers)} ${b.answers === 1 ? 'answer' : 'answers'}${tokens ? ` · ${n(tokens)} tokens (${n(b.inputTokens)} in, ${n(b.outputTokens)} out)` : ''} · $${b.spent}${of}`,
    `  each answer paid from your wallet to the node that served it`,
  ].join('\n');
}
