import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createIntro,
  gateTarget,
  INTRO_END_TEXT,
  INTRO_MIN_STAGE_PX,
  INTRO_SKIP_TO_MS,
  INTRO_START_TEXT,
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

describe("the intro controls", () => {
  const html = readFileSync("index.html", "utf8");
  const css = readFileSync("src/ui/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const textOf = (id: string): string => {
    const m = new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
    return (m?.[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  const rule = (selector: string): string => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((m[1] as string).trim().replace(/\s+/g, " ") === selector) return m[2] as string;
    }
    return "";
  };

  it("has one Skip intro pill with the Esc hint, hidden until the intro runs", () => {
    expect(count(html, 'id="intro-skip"')).toBe(1);
    expect(textOf("intro-skip")).toBe("Skip intro Esc");
    const tag = /<button[^>]*id="intro-skip"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/\bhidden\b/);
    expect(tag).toMatch(/class="[^"]*\bpill\b[^"]*\bintro-skip\b/);
    expect(html).toMatch(/<kbd>Esc<\/kbd>/);
  });

  it("has Replay intro in the stage controls after Follow attack", () => {
    expect(count(html, 'id="intro-replay"')).toBe(1);
    expect(textOf("intro-replay")).toBe("Replay intro");
    const controls = /<div id="stage-controls"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(controls.indexOf('id="follow-attack"')).toBeGreaterThan(-1);
    expect(controls.indexOf('id="intro-replay"')).toBeGreaterThan(
      controls.indexOf('id="follow-attack"'),
    );
    expect(controls).toMatch(/<button[^>]*id="intro-replay"[^>]*class="[^"]*\bghost\b/);
  });

  it("keeps every stage-control label to 14 characters or fewer, one line", () => {
    for (const label of [textOf("intro-skip"), textOf("follow-attack"), textOf("intro-replay")]) {
      expect(label.length, label).toBeLessThanOrEqual(14);
    }
    expect(rule(".pill")).toMatch(/white-space:\s*nowrap/);
  });

  it("has a polite live region, visually hidden", () => {
    expect(count(html, 'id="intro-status"')).toBe(1);
    const tag = /<p[^>]*id="intro-status"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/aria-live="polite"/);
    expect(tag).toMatch(/visually-hidden/);
    expect(INTRO_START_TEXT).toBe(
      "Intro: the five levels of the network fold into the dispatcher map. Press Escape to skip.",
    );
    expect(INTRO_END_TEXT).toBe("Intro finished.");
  });

  it("dims the inert panel to 55 percent and puts the skip pill at the bottom centre", () => {
    expect(rule(".panel[inert]")).toMatch(/opacity:\s*0\.55/);
    const skip = rule(".intro-skip");
    expect(skip).toMatch(/position:\s*absolute/);
    expect(skip).toMatch(/bottom:\s*var\(--space-md\)/);
    expect(skip).toMatch(/left:\s*50%/);
    expect(rule(".intro-skip kbd")).toMatch(/font-size:\s*var\(--fs-label\)/);
    expect(
      rule(".fallback:not([hidden]) ~ .stage-controls, .fallback:not([hidden]) ~ .intro-skip"),
    ).toMatch(/display:\s*none/);
  });

  it("names its level names in the display size, one line, with the doubled spaces kept", () => {
    const name = rule(".intro-name");
    expect(name).toMatch(/font-size:\s*var\(--fs-heading\)/);
    expect(name).toMatch(/font-weight:\s*600/);
    expect(name).toMatch(/white-space:\s*pre/);
  });
});
