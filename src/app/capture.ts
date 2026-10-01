import { loadPanelFonts } from "../ui/fonts";
import type { LoopDeps } from "./loop";

/**
 * Capture mode: the media are recorded from the real page, frame by frame, with the capture
 * script and not the wall clock deciding when the next frame happens. This module is compiled
 * only into a build made with `vite build --mode capture`; main.ts reaches it through a branch
 * on `import.meta.env.MODE` that the production build removes, so the shipped bundle carries no
 * way to drive its frames from outside.
 */

/** Simulated milliseconds per captured frame: 25 frames a second. */
export const CAPTURE_FRAME_MS = 40;

export interface ManualFrames {
  /** The scheduler the loop runs on instead of requestAnimationFrame. */
  deps: LoopDeps;
  /** Runs the one pending frame at the next 40 ms step; false when the loop has none pending. */
  frame(): boolean;
  /** How many frames have run. */
  frames(): number;
}

/**
 * A frame scheduler the caller steps by hand. Time is the frame counter times `frameMs`, exact
 * integers with no wall clock in them, so the same steps give the same ticks every time.
 */
export function createManualFrames(frameMs: number): ManualFrames {
  let pending: ((timeMs: number) => void) | undefined;
  let handle = 0;
  let current: number | undefined;
  let counter = 0;
  return {
    deps: {
      request(callback) {
        pending = callback;
        current = ++handle;
        return current;
      },
      cancel(wanted) {
        if (wanted === current) {
          pending = undefined;
          current = undefined;
        }
      },
    },
    frame() {
      const callback = pending;
      if (callback === undefined) return false;
      pending = undefined;
      current = undefined;
      counter += 1;
      callback(counter * frameMs);
      return true;
    },
    frames: () => counter,
  };
}

/** What the capture script sees on the page. */
export interface CaptureHook {
  frame(): boolean;
  frames(): number;
  /** Resolves once the page fonts are loaded, so the first captured frame has its final text. */
  ready: Promise<void>;
}

declare global {
  interface Window {
    __railBreachCapture?: CaptureHook;
  }
}

/** Exposes the manual frames to the capture script and marks the page so the CSS stops its own motion. */
export function installCaptureHook(manual: ManualFrames): void {
  window.__railBreachCapture = {
    frame: () => manual.frame(),
    frames: () => manual.frames(),
    ready: loadPanelFonts(document.fonts)
      .then(() => document.fonts.ready)
      .then(() => undefined),
  };
  document.documentElement.dataset.capture = "";
}
