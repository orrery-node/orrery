// A node's ledger (what routers signed to it and it has not redeemed yet) exists only in its data folder. Since a node
// waits until redeeming is worth the fee, there is money in that file between redemptions. This looks at the folder and
// says when a restart could take it away.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export type FolderFacts = { tmp?: string[]; container?: boolean; onRootDisk?: boolean };

/** The nearest folder on the way up that exists, and the names below it that do not exist yet. */
function nearest(p: string): { at: string; rest: string[] } {
  let at = resolve(p);
  const rest: string[] = [];
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return { at, rest };
}

/** The folder with links followed, also when its last parts are not made yet. */
const real = (p: string) => {
  const { at, rest } = nearest(p);
  try {
    return join(realpathSync(at), ...rest);
  } catch {
    return resolve(p);
  }
};

/** Why a folder may not outlive a restart: it is a temporary folder, or it sits on a container's own disk and not on
 * one mounted into it. Null when neither is seen, which is an absence of warning signs and not a promise. */
export function folderRisk(dir: string, facts: FolderFacts = {}): 'temporary' | 'container' | null {
  const at = real(dir);
  const tmps = (facts.tmp ?? [tmpdir(), '/tmp', '/var/tmp', '/dev/shm']).map(real);
  if (tmps.some((t) => at === t || at.startsWith(t.endsWith(sep) ? t : t + sep))) return 'temporary';
  const container = facts.container ?? (existsSync('/.dockerenv') || existsSync('/run/.containerenv') || !!process.env.KUBERNETES_SERVICE_HOST || !!process.env.RENDER);
  if (!container) return null;
  const onRootDisk = facts.onRootDisk ?? (() => {
    try {
      return statSync(nearest(at).at).dev === statSync('/').dev;
    } catch {
      return false;
    }
  })();
  return onRootDisk ? 'container' : null;
}

/** One sentence for the operator, or null when there is nothing to say. `waiting` is dollars, as printed elsewhere. */
export function folderWarning(dir: string, waiting: string, facts: FolderFacts = {}): string | null {
  const risk = folderRisk(dir, facts);
  if (risk === 'temporary') return `${dir} is a temporary folder: a restart can wipe it, and with it what routers signed to you and you have not redeemed ($${waiting} now). Set dataDir to a folder that stays`;
  if (risk === 'container') return `${dir} is on this container's own disk: when the container is replaced it is gone, and with it what routers signed to you and you have not redeemed ($${waiting} now). Mount a disk there`;
  return null;
}
