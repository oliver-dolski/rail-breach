import { setText, type Textual } from "./dom";

/** The part of the page that changes when WebGL2 is not available. */
export interface FallbackEls {
  canvas: { hidden: boolean | string };
  labels: { hidden: boolean | string };
  fallback: { hidden: boolean | string };
  message: Textual;
}

export const FALLBACK_MESSAGE =
  "The live map needs WebGL2, which is not available here. Below is a still of the dispatcher map; the panel on the right keeps running the same recorded session.";

/**
 * Swaps the canvas for the static image and an explanation. The panel is not
 * touched: it reads the same session, so the story still plays out there.
 */
export function showFallback(els: FallbackEls, reason: string): void {
  els.canvas.hidden = true;
  els.labels.hidden = true;
  els.fallback.hidden = false;
  setText(els.message, `${FALLBACK_MESSAGE} (${reason})`);
}
