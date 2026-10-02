import { describe, expect, it } from "vitest";
import { CAPTURE_FRAME_MS, createManualFrames } from "../../src/app/capture";
import { createIntro, gateTarget } from "../../src/app/intro";
import { startLoop } from "../../src/app/loop";
import { createAttractSession } from "../../src/app/session";
import { stateHash } from "../../src/core/hash";
import { INTRO_MS } from "../../src/render/intro/pose";
import { formatClock } from "../../src/ui/panel/log";

/** Ticks of the show at panel clock 00:18, where the first promise (signals at stop) is made. */
const TICKS_AT_18_S = 180;

interface Options {
  intro: boolean;
  frameMs?: number;
  /** The frame before which the viewer presses Skip. */
  skipBeforeFrame?: number;
}

interface Run {
  /** stateHash of the world at the moment the show reaches 00:18. */
  hash: string;
  /** The frame on which the world reached it. */
  frame: number;
  /** The panel clock on every frame the intro was playing. */
  introClocks: string[];
  /** stateHash of the world on the first and on the last intro frame. */
  worldDuringIntro: string[];
}

/**
 * The page's own wiring, without the GL: the loop on the manual frame clock, the simulation
 * stepped one tick at a time behind gateTarget, and the intro fed the loop's frame delta in the
 * render callback, exactly as main.ts does.
 */
function play(options: Options): Run {
  const session = createAttractSession();
  const manual = createManualFrames(options.frameMs ?? CAPTURE_FRAME_MS);
  const intro = options.intro ? createIntro(INTRO_MS) : undefined;
  const run: Run = { hash: "", frame: 0, introClocks: [], worldDuringIntro: [] };
  const sim = {
    advance(ticks: number): void {
      for (let i = 0; i < ticks; i++) {
        session.advance(1);
        if (run.hash === "" && session.elapsedTicks() >= TICKS_AT_18_S) {
          run.hash = stateHash(session.world());
          run.frame = manual.frames();
        }
      }
    },
  };
  startLoop(
    intro ? gateTarget(sim, intro) : sim,
    (_alpha, dtMs) => {
      if (intro?.running()) {
        intro.feed(dtMs);
        if (intro.running()) {
          run.introClocks.push(formatClock(session.elapsedTicks()));
          run.worldDuringIntro.push(stateHash(session.world()));
        }
      }
    },
    { deps: manual.deps },
  );
  for (let n = 1; run.hash === "" && n < 5000; n++) {
    if (n === options.skipBeforeFrame) intro?.skip();
    manual.frame();
  }
  return run;
}

describe("the intro never moves the clock promises (G8)", () => {
  const none = play({ intro: false });
  const full = play({ intro: true });
  const skipped = play({ intro: true, skipBeforeFrame: 37 });
  const long = play({ intro: true, frameMs: 250 });

  it("reaches a world at 00:18 in every variant", () => {
    for (const run of [none, full, skipped, long]) {
      expect(run.hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("gives a byte-identical world at 00:18 with no intro, after a full intro, after a skip and with 250 ms frames", () => {
    expect(full.hash).toBe(none.hash);
    expect(skipped.hash).toBe(none.hash);
    expect(long.hash).toBe(none.hash);
  });

  it("reaches 00:18 exactly 100 frames later after a full intro", () => {
    expect(full.frame).toBe(none.frame + INTRO_MS / CAPTURE_FRAME_MS);
  });

  it("reaches it sooner after a skip, and still later than with no intro", () => {
    expect(skipped.frame).toBeLessThan(full.frame);
    expect(skipped.frame).toBeGreaterThan(none.frame);
  });

  it("reads 00:00 on every frame of the intro, and the world does not change during it", () => {
    for (const run of [full, skipped, long]) {
      expect(run.introClocks.length).toBeGreaterThan(0);
      expect(new Set(run.introClocks)).toEqual(new Set(["00:00"]));
      expect(new Set(run.worldDuringIntro).size).toBe(1);
    }
    expect(full.introClocks.length).toBe(INTRO_MS / CAPTURE_FRAME_MS);
  });
});
