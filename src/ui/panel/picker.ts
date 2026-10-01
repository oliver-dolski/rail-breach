import type { Action } from "../../core/sim/actions";
import { validTargets } from "../../mapper/context";
import { SYNONYMS } from "../../mapper/synonyms";
import type { MapperContext, NodeEntry, TechniqueEntry } from "../../mapper/types";
import { h, setText } from "../dom";

/**
 * The technique picker: a search box over the catalogue and, for the technique picked, a
 * choice of the nodes it may be aimed at. It builds one technique.launch action and hands
 * it on; it never touches the world. Every string goes in as text.
 */

/**
 * The techniques whose id, legacy id, name or everyday wording contains the query,
 * case-insensitively, in catalogue order. An empty query lists all. The everyday wording
 * is the keyword matcher's synonym table, so "spoof" finds what free text "spoof" would.
 */
export function filterTechniques(
  techniques: readonly TechniqueEntry[],
  query: string,
): TechniqueEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...techniques];
  return techniques.filter((t) => {
    const haystack = [t.id, t.legacyId ?? "", t.name, ...(SYNONYMS[t.id] ?? [])];
    return haystack.some((text) => text.toLowerCase().includes(q));
  });
}

/** The action that launches `technique` at `node`: the engine checks the pair, so a bad one is refused there. */
export function launchAction(technique: string, node: string): Action {
  return { type: "technique.launch", technique, target: node };
}

/** One row of the list: the current id, the old one when there is one, and the name. */
export function rowLabel(t: TechniqueEntry): string {
  const legacy = t.legacyId === undefined ? "" : ` (was ${t.legacyId})`;
  return `${t.id}${legacy} ${t.name}`;
}

/**
 * The note after a launch. The engine decides whether a launch is allowed (T0840 needs a
 * foothold, for one) and the log says why when it is not, so the note only claims it was sent.
 */
export function launchNote(techniqueId: string, targetLabel: string): string {
  return `Sent ${techniqueId} to ${targetLabel}. The log shows whether it took.`;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface PickerDeps {
  ctx: MapperContext;
  onAction(action: Action): void;
}

export function createPicker(doc: Document, deps: PickerDeps): void {
  const search = need<HTMLInputElement>(doc, "picker-search");
  const list = need(doc, "picker-list");
  const target = need<HTMLSelectElement>(doc, "picker-target");
  const launch = need<HTMLButtonElement>(doc, "picker-launch");
  const note = need(doc, "picker-note");
  let picked: TechniqueEntry | undefined;

  const rows = new Map<string, HTMLElement>();
  for (const t of deps.ctx.techniques) {
    const row = h(doc, "button", {
      type: "button",
      "data-technique": t.id,
      "aria-pressed": "false",
    });
    row.append(
      h(doc, "span", { class: "picker-name" }, rowLabel(t)),
      h(doc, "span", { class: "picker-tactic" }, t.tactic.replaceAll("-", " ")),
    );
    row.addEventListener("click", () => pick(t));
    list.append(row);
    rows.set(t.id, row);
  }

  const fillTargets = (nodes: readonly NodeEntry[]): void => {
    target.replaceChildren(...nodes.map((n) => h(doc, "option", { value: n.id }, n.label)));
  };

  function pick(t: TechniqueEntry): void {
    picked = t;
    for (const [id, row] of rows) row.setAttribute("aria-pressed", id === t.id ? "true" : "false");
    fillTargets(validTargets(t, deps.ctx));
    target.disabled = target.options.length === 0;
    launch.disabled = target.options.length === 0;
    setText(note, `${t.name}: choose where to aim it.`);
  }

  search.addEventListener("input", () => {
    const shown = new Set(filterTechniques(deps.ctx.techniques, search.value).map((t) => t.id));
    for (const [id, row] of rows) row.hidden = !shown.has(id);
    setText(note, shown.size === 0 ? "No technique matches that." : "");
  });

  launch.addEventListener("click", () => {
    if (picked === undefined || target.value === "") return;
    deps.onAction(launchAction(picked.id, target.value));
    setText(note, launchNote(picked.id, target.selectedOptions[0]?.text ?? target.value));
  });
}
