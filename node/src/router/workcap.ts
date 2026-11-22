// What a router will pay for, for the kinds of work it can count itself. A node says how many tokens each answer took,
// and for chat the router has only its own estimate to hold that to. For images and speech it has more: the images that
// came back are in the answer, and the text it sent is its own. So it pays for no more images than arrived, and for
// prompts and spoken text by the same rule the node bills with, one input token per 4 characters.
import { IMAGE_TOKENS, imageCount, speechTokens } from '../manifest.ts';

export type WorkCap = { inputTokens: number; outputTokens: number; images?: number };

export function workCap(kind: string | undefined, body: Record<string, unknown>, answer: Record<string, unknown> | undefined): WorkCap | null {
  if (kind === 'image') {
    const got = Array.isArray(answer?.data) ? (answer!.data as unknown[]).length : 0;
    const images = Math.min(got, imageCount(body));
    return { inputTokens: speechTokens(body.prompt), outputTokens: images * IMAGE_TOKENS, images };
  }
  if (kind === 'speech') return { inputTokens: speechTokens(body.input), outputTokens: 0 };
  return null;
}

/** The tokens to pay for: what the node said, never more than the cap. */
export function capped(record: { inputTokens: number; outputTokens: number }, cap: WorkCap | null): { inputTokens: number; outputTokens: number; over: boolean } {
  if (!cap) return { ...record, over: false };
  const inputTokens = Math.min(record.inputTokens, cap.inputTokens), outputTokens = Math.min(record.outputTokens, cap.outputTokens);
  return { inputTokens, outputTokens, over: inputTokens < record.inputTokens || outputTokens < record.outputTokens };
}
