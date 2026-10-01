import { describe, expect, it } from "vitest";
import {
  createIntro,
  gateTarget,
  INTRO_MIN_STAGE_PX,
  INTRO_SKIP_TO_MS,
  type IntroConditions,
  shouldPlayIntro,
} from "../../src/app/intro";
import { INTRO_MS } from "../../src/render/intro/pose";

const FRAME = 40;

describe("the intro clock", () => {
  it("runs for 4000 ms, is in the layers phase below 3600, cross-fades from 3600 and is done at 4000", () => {
    expect(INTRO_MS).toBe(4000);
    expect(INTRO_SKIP_TO_MS).toBe(3600);
    const intro = createIntro(INTRO_MS);
    expect(intro.running()).toBe(true);
    intro.feed(0);
    expect(intro.elapsedMs()).toBe(0);
    expect(intro.phase()).toBe("layers");
    for (let t = FRAME; t < 3600; t += FRAME) {
      intro.feed(FRAME);
      expect(intro.running()).toBe(true);
      expect(intro.phase()).toBe("layers");
    }
    intro.feed(FRAME);
    expect(intro.elapsedMs()).toBe(3600);
    expect(intro.phase()).toBe("crossfade");
    for (let t = 3600 + FRAME; t < 4000; t += FRAME) {
      intro.feed(FRAME);
      expect(intro.running()).toBe(true);
    }
    intro.feed(FRAME);
    expect(intro.elapsedMs()).toBe(4000);
    expect(intro.running()).toBe(false);
    expect(intro.phase()).toBe("done");
    intro.feed(FRAME);
    expect(intro.elapsedMs()).toBe(4000);
  });

  it("is done on the 101st frame of the 40 ms clock, so it covers exactly 100 frames", () => {
    const intro = createIntro(INTRO_MS);
    let frames = 0;
    while (intro.running()) {
      intro.feed(frames === 0 ? 0 : FRAME);
      if (intro.running()) frames++;
    }
    expect(frames).toBe(100);
  });

  it("jumps to the 3600 ms pose on skip and still plays the cross-fade", () => {
    const intro = createIntro(INTRO_MS);
    intro.feed(0);
    intro.feed(1200);
    intro.skip();
    expect(intro.elapsedMs()).toBe(3600);
    expect(intro.running()).toBe(true);
    expect(intro.phase()).toBe("crossfade");
  });

  it("changes nothing when skipped during the cross-fade", () => {
    const intro = createIntro(INTRO_MS);
    intro.feed(0);
    intro.feed(3800);
    intro.skip();
    expect(intro.elapsedMs()).toBe(3800);
    expect(intro.running()).toBe(true);
  });

  it("ends at once when skipped before it has been fed, so the board starts at once", () => {
    const intro = createIntro(INTRO_MS);
    intro.skip();
    expect(intro.running()).toBe(false);
    expect(intro.phase()).toBe("done");
  });

  it("stops immediately on end() and ignores a skip afterwards", () => {
    const intro = createIntro(INTRO_MS);
    intro.feed(0);
    intro.feed(400);
    intro.end();
    expect(intro.running()).toBe(false);
    expect(intro.phase()).toBe("done");
    intro.skip();
    expect(intro.running()).toBe(false);
  });

  it("ignores a negative frame delta", () => {
    const intro = createIntro(INTRO_MS);
    intro.feed(0);
    intro.feed(-500);
    expect(intro.elapsedMs()).toBe(0);
  });
});

describe("who sees the intro", () => {
  const base: IntroConditions = {
    reducedMotion: false,
    search: "",
    tier: "high",
    fallback: false,
    stageWidthCss: 940,
    firstLoad: true,
  };

  it("plays on a high or standard tier, a stage of 560 px or more, no flag, first load", () => {
    expect(INTRO_MIN_STAGE_PX).toBe(560);
    expect(shouldPlayIntro(base)).toBe(true);
    expect(shouldPlayIntro({ ...base, tier: "standard" })).toBe(true);
    expect(shouldPlayIntro({ ...base, stageWidthCss: 560 })).toBe(true);
  });

  it("is off under reduced motion", () => {
    expect(shouldPlayIntro({ ...base, reducedMotion: true })).toBe(false);
  });

  it("is off with ?intro=0, and only with that literal", () => {
    expect(shouldPlayIntro({ ...base, search: "?intro=0" })).toBe(false);
    expect(shouldPlayIntro({ ...base, search: "?x=1&intro=0" })).toBe(false);
    expect(shouldPlayIntro({ ...base, search: "?intro=1" })).toBe(true);
    expect(shouldPlayIntro({ ...base, search: "?intro=00" })).toBe(true);
    expect(shouldPlayIntro({ ...base, search: "?intro" })).toBe(true);
    expect(shouldPlayIntro({ ...base, search: "?introduction=0" })).toBe(true);
  });

  it("is off in the lite tier, with no renderer and in the fallback", () => {
    expect(shouldPlayIntro({ ...base, tier: "lite" })).toBe(false);
    expect(shouldPlayIntro({ ...base, tier: undefined })).toBe(false);
    expect(shouldPlayIntro({ ...base, fallback: true })).toBe(false);
  });

  it("is off on a stage narrower than 560 CSS pixels", () => {
    expect(shouldPlayIntro({ ...base, stageWidthCss: 559 })).toBe(false);
  });

  it("is off when it is not the first load", () => {
    expect(shouldPlayIntro({ ...base, firstLoad: false })).toBe(false);
  });
});

describe("the gated loop target", () => {
  it("does not advance the target while the intro runs and forwards ticks once it is done", () => {
    const seen: number[] = [];
    const intro = createIntro(INTRO_MS);
    const gated = gateTarget({ advance: (n) => seen.push(n) }, intro);
    gated.advance(5);
    intro.feed(0);
    intro.feed(2000);
    gated.advance(5);
    expect(seen).toEqual([]);
    intro.feed(2000);
    expect(intro.running()).toBe(false);
    gated.advance(5);
    expect(seen).toEqual([5]);
  });

  it("forwards ticks again after end() and after a skip-to-end", () => {
    const seen: number[] = [];
    const intro = createIntro(INTRO_MS);
    const gated = gateTarget({ advance: (n) => seen.push(n) }, intro);
    intro.feed(0);
    intro.end();
    gated.advance(2);
    expect(seen).toEqual([2]);
  });
});
