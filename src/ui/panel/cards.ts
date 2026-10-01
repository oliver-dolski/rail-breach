/**
 * The cards of the side panel. The first three are always open; the other seven are native
 * <details> elements sharing one `name`, so the browser keeps at most one of them open. An
 * engine without the grouping just lets several stay open, which is harmless.
 */

/** Page order of the cards, top to bottom. */
export const CARD_IDS = [
  "card-safety",
  "card-session",
  "card-chain",
  "card-try",
  "card-defend",
  "card-compare",
  "card-timeline",
  "card-alerts",
  "card-events",
  "card-key",
] as const;

export type CardId = (typeof CARD_IDS)[number];

/** The `name` attribute that makes the lower cards one exclusive group. */
export const CARD_GROUP = "panel-card";

/** Opens a card when the page has it; a page or a test document without it is left alone. */
export function openCard(doc: Document, id: CardId): void {
  const card = doc.getElementById(id) as { open: boolean } | null;
  if (card !== null) card.open = true;
}
