import type { Keystore } from "../../app/keystore";
import { DEFAULT_MODEL, isKnownModel, MODELS } from "../../mapper/llm";
import { h, setText } from "../dom";

/**
 * The key and model controls of the free-text box. The key field is a password field that
 * is emptied the moment the key is taken, so the page never shows it again; the status line
 * only says whether one is held. The key is never written back into the page.
 */

export const STATUS_NO_KEY = "No key: text is read offline by keywords.";
export const STATUS_KEY =
  "Key held for this tab only. Interpret asks the LLM, keywords take over on any problem.";
export const STATUS_BAD_KEY = "That does not look like an API key, so nothing was stored.";

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface KeyPanel {
  /** The model chosen on the page: always one of MODELS. */
  model(): string;
}

export function createKeyPanel(doc: Document, keystore: Keystore): KeyPanel {
  const input = need<HTMLInputElement>(doc, "llm-key");
  const save = need<HTMLButtonElement>(doc, "llm-save");
  const forget = need<HTMLButtonElement>(doc, "llm-forget");
  const select = need<HTMLSelectElement>(doc, "llm-model");
  const status = need(doc, "llm-status");

  for (const id of MODELS) {
    select.append(h(doc, "option", { value: id }, id));
  }
  select.value = DEFAULT_MODEL;

  const refresh = (): void => {
    const held = keystore.getKey() !== undefined;
    setText(status, held ? STATUS_KEY : STATUS_NO_KEY);
    forget.disabled = !held;
  };
  // The keystore also changes on its own (a rejected key is forgotten), so follow it.
  keystore.onChange(refresh);

  const take = (): void => {
    const value = input.value;
    input.value = "";
    if (value.trim() === "") return;
    if (!keystore.setKey(value)) setText(status, STATUS_BAD_KEY);
  };
  save.addEventListener("click", take);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") take();
  });
  forget.addEventListener("click", () => {
    input.value = "";
    keystore.clearKey();
  });

  refresh();
  return { model: () => (isKnownModel(select.value) ? select.value : DEFAULT_MODEL) };
}
