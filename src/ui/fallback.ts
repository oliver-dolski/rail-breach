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

export const RENDER_FAILED_MESSAGE =
  "The live map could not start. Below is a still of the dispatcher map; the panel on the right keeps running the same recorded session.";

export const CONTEXT_LOST_MESSAGE =
  "The graphics context was lost and did not come back. Below is a still of the dispatcher map; the panel on the right keeps running the same recorded session.";

export const BOOT_FAILED_MESSAGE =
  "The page could not start. Below is a still of the dispatcher map.";

/**
 * Swaps the canvas for the static image and an explanation. The panel is not
 * touched: it reads the same session, so the story still plays out there.
 */
export function showFallback(
  els: FallbackEls,
  reason: string,
  message: string = FALLBACK_MESSAGE,
): void {
  els.canvas.hidden = true;
  els.labels.hidden = true;
  els.fallback.hidden = false;
  setText(els.message, `${message} (${reason})`);
}

interface PageElement extends Textual {
  hidden: boolean | string;
}

export interface PageDoc {
  getElementById(id: string): PageElement | null;
}

/**
 * Last resort for a failure anywhere in boot: explain it in the indicator and
 * show the still, using only what the page has. A blank map with a label stuck
 * on "checking" tells the viewer nothing. Never throws.
 */
export function reportBootFailure(doc: PageDoc, error: unknown): void {
  const reason = error instanceof Error ? error.message : "unknown error";
  const label = doc.getElementById("indicator-label");
  if (label) setText(label, "safety invariant: not checked");
  const detail = doc.getElementById("indicator-detail");
  if (detail) setText(detail, `The page could not start: ${reason}`);
  const canvas = doc.getElementById("map");
  const labels = doc.getElementById("labels");
  const fallback = doc.getElementById("fallback");
  const message = doc.getElementById("fallback-message");
  if (canvas && labels && fallback && message) {
    showFallback({ canvas, labels, fallback, message }, reason, BOOT_FAILED_MESSAGE);
  }
}
