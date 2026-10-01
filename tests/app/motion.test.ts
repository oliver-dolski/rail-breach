import { describe, expect, it } from "vitest";
import { type MotionMedia, watchReducedMotion } from "../../src/app/motion";

type Listener = (event: { matches: boolean }) => void;

function fakeMedia(
  initial: boolean,
): MotionMedia & { fire(matches: boolean): void; count(): number } {
  const listeners: Listener[] = [];
  const media = {
    matches: initial,
    addEventListener(_type: "change", listener: Listener) {
      listeners.push(listener);
    },
    removeEventListener(_type: "change", listener: Listener) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    fire(matches: boolean) {
      media.matches = matches;
      for (const listener of [...listeners]) listener({ matches });
    },
    count: () => listeners.length,
  };
  return media;
}

describe("the reduced-motion watcher", () => {
  it("starts from the value the browser reports, without calling back", () => {
    const calls: boolean[] = [];
    expect(watchReducedMotion(fakeMedia(true), (v) => calls.push(v)).current()).toBe(true);
    expect(watchReducedMotion(fakeMedia(false), (v) => calls.push(v)).current()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports every change at run time and keeps current() in step", () => {
    const media = fakeMedia(false);
    const calls: boolean[] = [];
    const watch = watchReducedMotion(media, (v) => calls.push(v));
    media.fire(true);
    expect(watch.current()).toBe(true);
    media.fire(false);
    expect(watch.current()).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it("stops listening after stop()", () => {
    const media = fakeMedia(false);
    const calls: boolean[] = [];
    const watch = watchReducedMotion(media, (v) => calls.push(v));
    watch.stop();
    expect(media.count()).toBe(0);
    media.fire(true);
    expect(calls).toEqual([]);
    expect(watch.current()).toBe(false);
  });
});
