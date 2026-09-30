import { h, setText } from "../dom";

/** What the selector needs to know of a scenario: how to list it and what to say about it. */
export interface ScenarioChoice {
  id: string;
  title: string;
  summary: string;
}

export interface ScenarioSelect {
  /** Shows which scenario is running, without announcing a change. */
  show(id: string): void;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

/**
 * The scenario selector: one option per scenario and a line about the one picked. Choosing
 * hands the id on and nothing else; the page rebuilds the session from that scenario's
 * committed recording. Titles and summaries come from content and go in as text.
 */
export function createScenarioSelect(
  doc: Document,
  choices: readonly ScenarioChoice[],
  onSelect: (id: string) => void,
): ScenarioSelect {
  const select = need<HTMLSelectElement>(doc, "scenario-select");
  const summary = need(doc, "scenario-summary");
  for (const choice of choices) {
    select.append(h(doc, "option", { value: choice.id }, choice.title));
  }
  const show = (id: string): void => {
    if (select.value !== id) select.value = id;
    setText(summary, choices.find((c) => c.id === id)?.summary ?? "");
  };
  select.addEventListener("change", () => {
    const id = select.value;
    if (choices.some((c) => c.id === id)) onSelect(id);
  });
  return { show };
}
