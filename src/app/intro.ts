import type { RenderTier } from "../render/gl/tier";
import { FOLD_END_MS } from "../render/intro/pose";
import type { LoopTarget } from "./loop";

/**
 * The intro's clock and the rules around it. The clock is fed the loop's frame delta and nothing
 * else, so it is frame-exact in capture and obeys the same clamp as the simulation. While it runs
 * the loop target is gated: the simulation does not move, and every promise the show makes is
 * counted from the end of the intro.
 */

/** A skip jumps here: the layers are flat, only the cross-fade is left. */
export const INTRO_SKIP_TO_MS = FOLD_END_MS;
/** A stage narrower than this (CSS pixels) shows the board at once. */
export const INTRO_MIN_STAGE_PX = 560;

export const INTRO_START_TEXT =
  "Intro: the five levels of the network fold into the dispatcher map. Press Escape to skip.";
export const INTRO_END_TEXT = "Intro finished.";

export type IntroPhase = "layers" | "crossfade" | "done";

export interface IntroClock {
  /** Adds one frame's elapsed milliseconds. The first frame of a start passes 0. */
  feed(dtMs: number): void;
  /** Jumps to the start of the cross-fade; before the first frame it ends the intro instead. */
  skip(): void;
  /** Ends the intro now: an error, a lost context, a weak GPU. */
  end(): void;
  running(): boolean;
  elapsedMs(): number;
  phase(): IntroPhase;
}

export function createIntro(durationMs: number): IntroClock {
  let elapsed = 0;
  let fed = false;
  let finished = false;
  return {
    feed(dtMs) {
      if (finished) return;
      fed = true;
      elapsed = Math.min(durationMs, elapsed + Math.max(0, dtMs));
      if (elapsed >= durationMs) finished = true;
    },
    skip() {
      if (finished) return;
      if (!fed) {
        finished = true;
        return;
      }
      elapsed = Math.max(elapsed, INTRO_SKIP_TO_MS);
    },
    end() {
      finished = true;
    },
    running: () => !finished,
    elapsedMs: () => elapsed,
    phase: () => (finished ? "done" : elapsed < INTRO_SKIP_TO_MS ? "layers" : "crossfade"),
  };
}

export interface IntroConditions {
  reducedMotion: boolean;
  /** The query string of the address; only the literal intro=0 is honoured. */
  search: string;
  /** The renderer's tier; undefined when there is no renderer at all. */
  tier: RenderTier | undefined;
  /** True while the static still replaces the map. */
  fallback: boolean;
  stageWidthCss: number;
  firstLoad: boolean;
}

/** The literal flag intro=0 as a whole query parameter; nothing else in the query is read. */
const INTRO_OFF_FLAG = /(?:^|[?&])intro=0(?:&|$)/;

export function shouldPlayIntro(c: IntroConditions): boolean {
  if (c.reducedMotion || c.fallback || !c.firstLoad) return false;
  if (c.tier === undefined || c.tier === "lite") return false;
  if (c.stageWidthCss < INTRO_MIN_STAGE_PX) return false;
  return !INTRO_OFF_FLAG.test(c.search);
}

/** The loop target with the simulation held still for as long as the intro runs. */
export function gateTarget(target: LoopTarget, intro: Pick<IntroClock, "running">): LoopTarget {
  return {
    advance(ticks) {
      if (intro.running()) return;
      target.advance(ticks);
    },
  };
}
