import type { ViewState } from "../../core/sim/world";
import type { ViewMode } from "../../render/view";
import { setText } from "../dom";

/**
 * The switch between ground truth and the operator view. Its state lives here, in the
 * page, and nowhere else: it is not an Action, it is never recorded and it cannot reach
 * the world. The only thing it changes is which way the map is drawn from a snapshot.
 */

export interface ViewToggle {
  mode(): ViewMode;
  /** Words the current picture in the note next to the switch. */
  note(reporting: ViewState): void;
}

const FEED_WORDS: Record<Exclude<ViewState, "ok">, string> = {
  spoofed: "being fed reports that look right and are not",
  frozen: "frozen at an earlier moment",
  blank: "blank",
};

/** What the note beside the switch says, for the picture shown and the state of the operators' feed. */
export function pictureNote(mode: ViewMode, reporting: ViewState): string {
  if (reporting === "ok") {
    return mode === "operator"
      ? "Operator view: the consoles match the real line."
      : "Ground truth: the consoles match the real line.";
  }
  const feed = FEED_WORDS[reporting];
  return mode === "operator"
    ? `Operator view: the consoles are ${feed}. Switch to ground truth to see the real line.`
    : `Ground truth. The consoles are ${feed}; switch to operator view to see what the dispatchers see.`;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export function createViewToggle(doc: Document): ViewToggle {
  const group = need(doc, "view-mode");
  const note = need(doc, "view-note");
  let mode: ViewMode = "ground-truth";
  let lastReporting: ViewState = "ok";

  const write = (): void => setText(note, pictureNote(mode, lastReporting));

  group.addEventListener("click", (event) => {
    const chosen = (event.target as HTMLElement).getAttribute("data-mode");
    if (chosen !== "ground-truth" && chosen !== "operator") return;
    mode = chosen;
    for (const button of Array.from(group.querySelectorAll("button"))) {
      button.setAttribute(
        "aria-pressed",
        button.getAttribute("data-mode") === mode ? "true" : "false",
      );
    }
    write();
  });

  return {
    mode: () => mode,
    note(reporting) {
      lastReporting = reporting;
      write();
    },
  };
}
