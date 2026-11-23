/** Evenly timed, evenly sized answer frames. Padding each frame (padFrame) hides how long each token is, but a
 * streamed answer still goes out about a token per frame, so how many frames there are and when each leaves spell out
 * the answer's length and the rhythm of its tokens to anything watching the connection. A router that asks for it
 * (x-orrery-frame-ms, on a sealed request) gets the first chunk at once and then one frame every so many
 * milliseconds, holding whatever chunks came in since, or none: the count follows the time the answer took and nothing
 * else, and every frame is padded to the same 4 KiB block. */
export const PACED_BLOCK = 4096;

/** The pace a router asked for, kept between 20 ms and one second; anything else is no pacing. */
export function paceFrom(header: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(n) && n >= 20 && n <= 1000 ? Math.round(n) : null;
}

export class Pacer {
  private pending: unknown[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly everyMs: number, private readonly out: (frame: string) => void) {}

  /** A chunk from the model server: the first goes out at once, the rest wait for the next beat. */
  push(chunk: unknown): void {
    if (this.timer) {
      this.pending.push(chunk);
      return;
    }
    this.out(JSON.stringify([chunk]));
    this.timer = setInterval(() => this.beat(), this.everyMs);
  }

  private beat(): void {
    const p = this.pending;
    this.pending = [];
    this.out(JSON.stringify(p));
  }

  /** The answer is done: whatever is still held goes out, and the beat stops. */
  end(): void {
    this.stop();
    if (this.pending.length) this.beat();
  }

  /** Stops the beat without sending anything more. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
