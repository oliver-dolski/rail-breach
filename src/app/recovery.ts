/**
 * What happens when the graphics side fails after the page has started: the
 * panel and the simulation carry on, the map is swapped for the still and the
 * viewer is told why. None of this touches the simulation.
 */

/** How long a lost WebGL context gets to come back before the still replaces the map. */
export const CONTEXT_RESTORE_GRACE_MS = 3000;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `create`; when it throws, reports why (for the fallback) and returns undefined. */
export function attempt<T>(create: () => T, onFail: (reason: string) => void): T | undefined {
  try {
    return create();
  } catch (error) {
    onFail(error instanceof Error ? error.message : "unknown error");
    return undefined;
  }
}

export interface LossGuard {
  lost(): void;
  restored(): void;
}

/**
 * The browser may restore a lost context, but nothing promises it will. After
 * `graceMs` without a restore the guard gives up once and calls `onGiveUp`.
 */
export function createLossGuard(timers: Timers, graceMs: number, onGiveUp: () => void): LossGuard {
  let timer: unknown;
  let waiting = false;
  const cancel = (): void => {
    if (waiting) timers.clear(timer);
    waiting = false;
  };
  return {
    lost() {
      cancel();
      waiting = true;
      timer = timers.set(() => {
        waiting = false;
        onGiveUp();
      }, graceMs);
    },
    restored() {
      cancel();
    },
  };
}
