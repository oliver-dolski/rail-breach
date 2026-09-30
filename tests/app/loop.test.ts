import { describe, expect, it } from "vitest";
import {
  createAccumulator,
  type LoopDeps,
  MAX_CATCH_UP_TICKS,
  MAX_FRAME_MS,
  startLoop,
} from "../../src/app/loop";
import { createAttractSession } from "../../src/app/session";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { stateHash } from "../../src/core/hash";
import { TICK_MS } from "../../src/core/sim/constants";
import { buildView, createViewContext } from "../../src/render/view";

describe("the accumulator", () => {
  it("turns elapsed time into whole ticks and keeps the remainder for interpolation", () => {
    const acc = createAccumulator();
    expect(acc.feed(TICK_MS)).toEqual({ ticks: 1, alpha: 0 });
    const half = acc.feed(TICK_MS / 2);
    expect(half.ticks).toBe(0);
    expect(half.alpha).toBeCloseTo(0.5, 9);
    const rest = acc.feed(TICK_MS / 2 + TICK_MS);
    expect(rest.ticks).toBe(1 + 1);
    expect(rest.alpha).toBeCloseTo(0, 9);
  });

  it("gives the same tick count however the frames are cut (frame-rate independence)", () => {
    const seconds = 20;
    const ticksAt = (fps: number): number => {
      const acc = createAccumulator();
      let total = 0;
      for (let i = 0; i < seconds * fps; i++) total += acc.feed(1000 / fps).ticks;
      return total;
    };
    for (const fps of [24, 30, 60, 144, 240]) {
      expect(Math.abs(ticksAt(fps) - seconds * 10), `${fps} fps`).toBeLessThanOrEqual(1);
    }
  });

  it("caps catch-up after a long stall instead of spiralling", () => {
    const acc = createAccumulator();
    const stalled = acc.feed(60_000);
    expect(stalled.ticks).toBeLessThanOrEqual(Math.ceil(MAX_FRAME_MS / TICK_MS));
    // A fast-forward factor that would need more than the cap drops the backlog.
    const fast = createAccumulator().feed(MAX_FRAME_MS, 100);
    expect(fast.ticks).toBe(MAX_CATCH_UP_TICKS);
    expect(fast.alpha).toBe(0);
    // And the next normal frame is normal again.
    const acc2 = createAccumulator();
    acc2.feed(MAX_FRAME_MS, 100);
    expect(acc2.feed(TICK_MS).ticks).toBe(1);
  });

  it("ignores a clock that runs backwards", () => {
    const acc = createAccumulator();
    expect(acc.feed(-500).ticks).toBe(0);
  });
});

/** A scheduler the test drives by hand. */
function fakeFrames(): { deps: LoopDeps; frame(ms: number): void; pending(): boolean } {
  let next: ((t: number) => void) | undefined;
  let now = 0;
  let handle = 0;
  return {
    deps: {
      request(cb) {
        next = cb;
        return ++handle;
      },
      cancel() {
        next = undefined;
      },
    },
    frame(ms) {
      now += ms;
      const cb = next;
      next = undefined;
      cb?.(now);
    },
    pending: () => next !== undefined,
  };
}

describe("startLoop", () => {
  it("advances the target by the right integer number of ticks and renders every frame", () => {
    const frames = fakeFrames();
    const advanced: number[] = [];
    const alphas: number[] = [];
    startLoop({ advance: (n) => advanced.push(n) }, (alpha) => alphas.push(alpha), {
      deps: frames.deps,
    });
    frames.frame(0);
    for (let i = 0; i < 60; i++) frames.frame(1000 / 60);
    expect(alphas).toHaveLength(61);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
    const total = advanced.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 10)).toBeLessThanOrEqual(1);
    for (const n of advanced) expect(Number.isInteger(n) && n > 0).toBe(true);
  });

  it("does not advance while paused, and resuming does not replay the pause", () => {
    const frames = fakeFrames();
    let ticks = 0;
    const loop = startLoop({ advance: (n) => (ticks += n) }, () => undefined, {
      deps: frames.deps,
    });
    frames.frame(0);
    frames.frame(100);
    expect(ticks).toBe(1);

    loop.pause();
    expect(loop.running).toBe(false);
    expect(frames.pending()).toBe(false);
    frames.frame(10_000);
    expect(ticks).toBe(1);

    loop.resume();
    expect(loop.running).toBe(true);
    frames.frame(5000);
    frames.frame(100);
    expect(ticks).toBe(2);
  });

  it("stops scheduling frames once stopped", () => {
    const frames = fakeFrames();
    const loop = startLoop({ advance: () => undefined }, () => undefined, { deps: frames.deps });
    frames.frame(0);
    loop.stop();
    expect(frames.pending()).toBe(false);
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe("rendering never writes to the world", () => {
  it("leaves the simulation state byte-identical across many drawn frames", () => {
    const session = createAttractSession();
    const view = createViewContext(network, session.index, layout);
    const frames = fakeFrames();
    let checked = 0;
    startLoop(
      { advance: (n) => session.advance(n) },
      (alpha) => {
        // Frozen, so any write from the render path throws instead of passing unnoticed.
        const world = deepFreeze(session.world());
        const prev = session.previous();
        if (prev) deepFreeze(prev);
        const before = stateHash(world);
        buildView(world, view, { prev, alpha });
        // The world object the renderer saw must still be the state it hashed before drawing.
        expect(stateHash(world)).toBe(before);
        checked++;
      },
      { deps: frames.deps },
    );
    frames.frame(0);
    for (let i = 0; i < 240; i++) frames.frame(1000 / 60);
    expect(checked).toBe(241);
    expect(session.world().tick).toBeGreaterThan(session.scenario.startTick + 30);
  });
});
