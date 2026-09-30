/**
 * Stateless counter-based dice. There is no mutable generator: every decision is
 * a pure function of (seed, ...keys), so draw order cannot desync anything and
 * adding an unrelated roll never shifts another one.
 *
 * String subjects and purposes are interned to small ints once, at content load
 * (see internKey), never in the tick hot path.
 */

/** murmur3 finalizer: a bijective avalanche mix on uint32. */
function fmix32(input: number): number {
  let h = input | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Deterministic uint32 for the given keys. The seed is mixed on its own before
 * any key is folded in, so (seed=1, key=2) and (seed=2, key=1) do not collide,
 * and each key is folded in order-sensitively.
 */
export function roll32(seed: number, ...keys: number[]): number {
  let h = fmix32(seed);
  for (const key of keys) {
    h = fmix32((Math.imul(h, 0x9e3779b1) + (key | 0)) | 0);
  }
  return h;
}

/** True with probability permille/1000. Args are (seed, ...keys) as for roll32. */
export function chance(permille: number, ...args: [number, ...number[]]): boolean {
  return roll32(...args) % 1000 < permille;
}

/** Interns a string subject/purpose to a uint32 key. Call at content load only. */
export function internKey(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}
