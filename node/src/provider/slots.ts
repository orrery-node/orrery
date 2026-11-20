// How many answers a node streams from its model server at once (provider.json "slots"), and who waits for the next
// free one. A request from a wallet that gets this node's holder price goes ahead of requests that do not, the larger
// discount first; among equals it is first come, first served. A request that waits longer than `waitMs` is turned
// away as busy before anything is signed or owed, so its router asks the next node.

export type SlotState = { size: number; busy: number; waiting: number; holdersWaiting: number; holdersAhead: number };

/** A slot: `give` hands it back (calling it twice hands it back once). `passed` is how many requests without a holder
 * price that had arrived earlier this one went ahead of; `waitedMs` how long it waited. */
export type Taken = { give: () => void; passed: number; waitedMs: number };

type Waiter = { off: number; seq: number; go: () => void; timer: ReturnType<typeof setTimeout> };

/** The most slots a node may set: past this the model server is the limit, not the node. */
export const MAX_SLOTS = 1_024;

/** A node's "slots" from provider.json: a whole number from 1 to MAX_SLOTS, or nothing (no limit). */
export function checkSlots(n: unknown): number | undefined {
  if (n === undefined) return undefined;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SLOTS) throw new Error(`"slots" must be a whole number from 1 to ${MAX_SLOTS} (how many answers the node streams from its model server at once), not ${JSON.stringify(n)}`);
  return n;
}

/** "4 of 4 answering, 2 waiting (1 a holder); holders went ahead 3 times since start". `provider status` and the node's
 * console both say it; the console carries this function's own source, so it refers to nothing outside itself. */
export function slotsSentence(s: SlotState): string {
  const waiting = s.waiting ? `, ${s.waiting} waiting${s.holdersWaiting ? ` (${s.holdersWaiting} ${s.holdersWaiting === 1 ? 'a holder' : 'holders'})` : ''}` : ', none waiting';
  const ahead = s.holdersAhead ? `; holders went ahead ${s.holdersAhead === 1 ? 'once' : `${s.holdersAhead} times`} since start` : '';
  return `${s.busy} of ${s.size} answering${waiting}${ahead}`;
}

/** `orrery provider status`: "  slots                 4 of 4 answering, 2 waiting (1 a holder); holders went ahead 3 times since start". */
export function slotsLine(s: SlotState): string {
  return `  slots                 ${slotsSentence(s)}`;
}

export class Slots {
  private busy = 0;
  private seq = 0;
  private waiting: Waiter[] = [];
  /** Holder requests that took a slot ahead of a request without a holder price that had arrived before them. */
  private ahead = 0;

  constructor(readonly size: number, readonly waitMs = 30_000) {}

  /** A slot for a request at this holder discount (basis points, 0 for none) once one is free; null when none came
   * free within `waitMs`. */
  take(off: number): Promise<Taken | null> {
    const t0 = Date.now();
    if (this.busy < this.size && !this.waiting.length) {
      this.busy += 1;
      return Promise.resolve({ give: this.giveBack(), passed: 0, waitedMs: 0 });
    }
    return new Promise((resolve) => {
      const w: Waiter = {
        off,
        seq: this.seq++,
        go: () => {
          clearTimeout(w.timer);
          const passed = off > 0 ? this.waiting.filter((x) => x.off === 0 && x.seq < w.seq).length : 0;
          if (passed) this.ahead += 1;
          this.busy += 1;
          resolve({ give: this.giveBack(), passed, waitedMs: Date.now() - t0 });
        },
        timer: setTimeout(() => {
          this.waiting = this.waiting.filter((x) => x !== w);
          resolve(null);
        }, this.waitMs),
      };
      const at = this.waiting.findIndex((x) => x.off < off);
      if (at === -1) this.waiting.push(w);
      else this.waiting.splice(at, 0, w);
    });
  }

  get state(): SlotState {
    return { size: this.size, busy: this.busy, waiting: this.waiting.length, holdersWaiting: this.waiting.filter((w) => w.off > 0).length, holdersAhead: this.ahead };
  }

  private giveBack() {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.busy -= 1;
      while (this.busy < this.size && this.waiting.length) this.waiting.shift()!.go();
    };
  }
}
