import { TICK_MS } from "../core/sim/constants";

/**
 * The fixed-timestep loop. This module and main.ts are the only places that
 * know about wall-clock time: the simulation counts integer ticks and never
 * learns how long a frame took, so replay does not depend on frame rate.
 */

/** A long frame (tab in the background, debugger) counts as at most this much time. */
export const MAX_FRAME_MS = 250;

/** Ticks advanced in one frame at most; the rest of the backlog is dropped. */
export const MAX_CATCH_UP_TICKS = 8;

export interface Accumulator {
  /** Adds one frame's elapsed time and returns whole ticks to run plus the leftover fraction. */
  feed(dtMs: number, speed?: number): { ticks: number; alpha: number };
  reset(): void;
}

export function createAccumulator(): Accumulator {
  let acc = 0;
  return {
    feed(dtMs, speed = 1) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
      acc += dt * speed;
      let ticks = Math.floor(acc / TICK_MS);
      if (ticks > MAX_CATCH_UP_TICKS) {
        // Spiral of death guard: run what a frame can afford and forget the rest.
        ticks = MAX_CATCH_UP_TICKS;
        acc = 0;
      } else {
        acc -= ticks * TICK_MS;
      }
      return { ticks, alpha: acc / TICK_MS };
    },
    reset() {
      acc = 0;
    },
  };
}

export interface LoopDeps {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export const browserDeps: LoopDeps = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface LoopTarget {
  advance(ticks: number): void;
}

export interface LoopOptions {
  /** Simulated seconds per real second. */
  speed?: number;
  deps?: LoopDeps;
}

export interface LoopHandle {
  pause(): void;
  resume(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Advances `target` by whole ticks according to elapsed frame time, then calls
 * `render` with the interpolation fraction. Render reads; it never writes the
 * world. While paused no ticks run, and resuming does not replay the pause.
 */
export function startLoop(
  target: LoopTarget,
  render: (alpha: number) => void,
  options: LoopOptions = {},
): LoopHandle {
  const deps = options.deps ?? browserDeps;
  const speed = options.speed ?? 1;
  const acc = createAccumulator();
  let handle: number | undefined;
  let last: number | undefined;
  let running = false;

  const frame = (timeMs: number): void => {
    handle = undefined;
    if (!running) return;
    const dt = last === undefined ? 0 : timeMs - last;
    last = timeMs;
    const { ticks, alpha } = acc.feed(dt, speed);
    if (ticks > 0) target.advance(ticks);
    render(alpha);
    if (running) handle = deps.request(frame);
  };

  const handleApi: LoopHandle = {
    pause() {
      running = false;
      if (handle !== undefined) deps.cancel(handle);
      handle = undefined;
    },
    resume() {
      if (running) return;
      running = true;
      last = undefined;
      acc.reset();
      handle = deps.request(frame);
    },
    stop() {
      handleApi.pause();
    },
    get running() {
      return running;
    },
  };
  handleApi.resume();
  return handleApi;
}
