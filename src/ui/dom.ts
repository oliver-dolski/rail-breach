/**
 * Tiny DOM helpers. Text always goes in through textContent or text nodes, never
 * innerHTML: labels, log lines and refusal reasons come from content and from
 * the engine, and this page will later sit next to an API key in sessionStorage.
 */

export interface Textual {
  textContent: string | null;
}

/** Sets text only when it changed, so an unchanged panel costs no DOM writes. */
export function setText(el: Textual, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const FORBIDDEN_ATTRS = /^(on|style$|srcdoc$)/i;

/** Attributes whose value is a URL the browser will follow or load. */
const URL_ATTRS = /^(href|src|action|formaction|poster|data|xlink:href)$/i;

/** A URL may point at this site, at a fragment, or at https. Anything else, javascript: included, is refused. */
const SAFE_URL = /^(\/(?!\/)|#|https:\/\/)/i;

/**
 * Creates an element. Attribute names that can run script or bypass the CSP are
 * refused, and so are URL attributes whose value is not local or https.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  ...children: readonly (string | Node)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (FORBIDDEN_ATTRS.test(name)) throw new Error(`attribute "${name}" is not allowed`);
    if (URL_ATTRS.test(name) && !SAFE_URL.test(value)) {
      throw new Error(`attribute "${name}" does not accept that URL`);
    }
    el.setAttribute(name, value);
  }
  for (const child of children) el.append(child);
  return el;
}

export interface ListItem {
  key: string;
  text: string;
  /** Short class suffix, for colouring by kind. */
  tone?: string;
}

/**
 * Keeps the children of `parent` in step with `items`: elements are reused by
 * key, created for new keys, removed for missing ones and put in the given order.
 */
export function syncList(
  doc: Document,
  parent: HTMLElement,
  items: readonly ListItem[],
  tag: "li" | "span" | "div" = "li",
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children)) {
    const key = child.getAttribute("data-key");
    if (key !== null && child instanceof HTMLElement) existing.set(key, child);
  }
  const wanted = new Set(items.map((i) => i.key));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();

  let cursor: Element | null = parent.firstElementChild;
  for (const item of items) {
    let el = existing.get(item.key);
    if (!el) {
      el = h(doc, tag, { "data-key": item.key });
      existing.set(item.key, el);
    }
    setText(el, item.text);
    const cls = item.tone === undefined ? "" : `tone-${item.tone}`;
    if (el.getAttribute("class") !== cls) el.setAttribute("class", cls);
    if (el !== cursor) parent.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
  }
}
