import type { Action } from "../../core/sim/actions";
import { isAction } from "../../core/sim/actions";
import { MAX_TEXT_LENGTH } from "../../mapper/schema";
import type { Intent, MapperContext, MapResult, TechniqueMapper } from "../../mapper/types";
import { type ListItem, setText, syncList } from "../dom";

/**
 * The free-text box: what the viewer typed becomes "interpreted as" chips first, and
 * nothing runs until Run is pressed. Whatever mapper is behind it (offline keywords, or an
 * LLM that falls back to them), it is only ever asked on a button press, never from the
 * address bar, and the text it gets back is shown as text.
 */

/** One chip per step: the technique id and name, and where it is aimed when it names a place. */
export function chipItems(intents: readonly Intent[], ctx: MapperContext): ListItem[] {
  return intents.map((intent, i) => {
    const name = ctx.techniques.find((t) => t.id === intent.technique)?.name ?? "";
    const where =
      intent.target === undefined
        ? ""
        : ` at ${Object.entries(intent.target)
            .map(([kind, value]) => `${kind} ${value}`)
            .join(", ")}`;
    return {
      key: `${i}:${intent.technique}`,
      text: `${intent.technique} ${name}${where}`,
      tone: "chip",
    };
  });
}

/** Which mapper produced the chips, and the mapper's own note (a fallback reason, what was ignored). */
export function sourceLine(result: MapResult): string {
  const source =
    result.source === "llm"
      ? "Interpreted by the LLM."
      : "Interpreted by the offline keyword matcher.";
  return result.intents.length === 0
    ? (result.note ?? "Nothing to run.")
    : [source, result.note].filter((s) => s !== undefined && s !== "").join(" ");
}

/** The action that runs a mapping, or undefined when it is empty or not a well-formed playbook. */
export function runAction(result: MapResult): Action | undefined {
  if (result.intents.length === 0) return undefined;
  const action: Action = { type: "playbook.start", steps: result.intents };
  return isAction(action) ? action : undefined;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface FreeTextDeps {
  ctx: MapperContext;
  mapper: TechniqueMapper;
  onAction(action: Action): void;
}

export function createFreeText(doc: Document, deps: FreeTextDeps): void {
  const input = need<HTMLInputElement>(doc, "freetext-input");
  const interpret = need<HTMLButtonElement>(doc, "freetext-map");
  const chips = need(doc, "freetext-chips");
  const note = need(doc, "freetext-note");
  const run = need<HTMLButtonElement>(doc, "freetext-run");
  let current: MapResult | undefined;
  let pending = false;
  /** Bumped on every edit of the box, so an answer for text that is gone can be told apart. */
  let edits = 0;

  input.maxLength = MAX_TEXT_LENGTH;

  const show = (result: MapResult | undefined, line: string): void => {
    current = result;
    syncList(doc, chips, result === undefined ? [] : chipItems(result.intents, deps.ctx), "span");
    setText(note, line);
    run.disabled = result === undefined || runAction(result) === undefined;
  };

  const interpretNow = async (): Promise<void> => {
    if (pending) return;
    pending = true;
    interpret.disabled = true;
    setText(note, "Interpreting...");
    const asked = edits;
    try {
      const result = await deps.mapper.map(input.value, deps.ctx);
      // The box was edited while the mapper worked: this answer is for text no longer shown.
      if (asked === edits) show(result, sourceLine(result));
    } catch {
      // A mapper is meant to fall back itself; if one throws anyway, nothing runs.
      if (asked === edits) show(undefined, "The text could not be interpreted.");
    } finally {
      pending = false;
      interpret.disabled = false;
    }
  };

  interpret.addEventListener("click", () => void interpretNow());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void interpretNow();
  });
  // Edited text is no longer what the chips say, so the chips go.
  input.addEventListener("input", () => {
    edits++;
    if (current !== undefined || pending) show(undefined, "");
  });
  run.addEventListener("click", () => {
    const action = current === undefined ? undefined : runAction(current);
    if (action === undefined) return;
    deps.onAction(action);
    setText(note, `Started ${current?.intents.length ?? 0} step(s), one after the other.`);
    run.disabled = true;
  });
  show(undefined, "");
}
