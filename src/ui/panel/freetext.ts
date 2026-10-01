import type { Layout } from "../../content/layout";
import type { Action } from "../../core/sim/actions";
import { isAction } from "../../core/sim/actions";
import { validTargets } from "../../mapper/context";
import { MAX_TEXT_LENGTH } from "../../mapper/schema";
import type { Intent, MapperContext, MapResult, TechniqueMapper } from "../../mapper/types";
import { type ListItem, setText, syncList } from "../dom";

/**
 * The free-text box: what the viewer typed becomes "interpreted as" chips first, and
 * nothing runs until Run is pressed. Whatever mapper is behind it (offline keywords, or an
 * LLM that falls back to them), it is only ever asked on a button press, never from the
 * address bar, and the text it gets back is shown as text.
 */

/** The names the map shows for a node and a zone: what a chip says instead of an id. */
export interface ChipNames {
  node(id: string): string;
  zone(id: string): string;
}

/** Chip names from the layout: the labels the map and the event log use, the id when there is none. */
export function chipNamesFrom(layout: Layout): ChipNames {
  return {
    node: (id) => layout.nodes[id]?.label ?? id,
    zone: (id) => layout.zones.find((z) => z.id === id)?.label ?? id,
  };
}

/**
 * One chip per step: the technique id and name, and where it is aimed when it names a place,
 * in the map's own words. A role names the machines that carry it and that the technique
 * may be aimed at (all holders when none is admitted), never the role id.
 */
export function chipItems(
  intents: readonly Intent[],
  ctx: MapperContext,
  names: ChipNames,
): ListItem[] {
  const where = (intent: Intent): string => {
    const target = intent.target;
    if (target === undefined) return "";
    if ("node" in target) return ` at ${names.node(target.node)}`;
    if ("zone" in target) return ` in ${names.zone(target.zone)}`;
    const technique = ctx.techniques.find((t) => t.id === intent.technique);
    const holders = ctx.nodes.filter((n) => n.roles.includes(target.role));
    const admitted = technique === undefined ? [] : validTargets(technique, ctx).map((n) => n.id);
    const fitting = holders.filter((n) => admitted.includes(n.id));
    const labels = (fitting.length > 0 ? fitting : holders).map((n) => names.node(n.id));
    return ` at ${[...new Set(labels)].join(" or ")}`;
  };
  return intents.map((intent, i) => {
    const name = ctx.techniques.find((t) => t.id === intent.technique)?.name ?? "";
    return {
      key: `${i}:${intent.technique}`,
      text: `${intent.technique} ${name}${where(intent)}`,
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
  /** Node and zone labels as the map shows them, for the chips. */
  names: ChipNames;
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
    syncList(
      doc,
      chips,
      result === undefined ? [] : chipItems(result.intents, deps.ctx, deps.names),
      "span",
    );
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
