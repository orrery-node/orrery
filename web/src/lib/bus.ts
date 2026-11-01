import type { RTrip } from './rehearsal';

export type Stage = 'hero' | 'routes' | 'voucher' | 'zero' | 'sealed' | 'provide' | 'quiet';

export type BusEvents = {
  'yard:stage': { stage: Stage; progress: number; provide: number };
  'yard:fire': { route: string };
  'yard:sent': { trip: RTrip; at: number };
  'yard:served': { trip: RTrip };
  'yard:paid': { trip: RTrip };
};

export function emit<K extends keyof BusEvents>(name: K, detail: BusEvents[K]) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on<K extends keyof BusEvents>(name: K, fn: (d: BusEvents[K]) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<BusEvents[K]>).detail);
  window.addEventListener(name, h);
  return () => window.removeEventListener(name, h);
}

export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
