import { validTargets } from "./context";
import { MAX_TEXT_LENGTH, validateIntents } from "./schema";
import { SYNONYMS, TARGET_HINTS } from "./synonyms";
import type { Intent, MapperContext, MapResult, TechniqueEntry, TechniqueMapper } from "./types";

/**
 * The offline matcher: pure and deterministic, the same text always gives the same list.
 * It works on words, not on the string: lower-case, punctuation gone, filler words gone.
 * A technique matches by its id (either form) or by a synonym; its place in the list is
 * where its first match stands in the text, so "spoof the reports, then block commands"
 * runs in that order. Ties go to the catalogue order.
 */

const FILLER = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "at",
  "into",
  "for",
  "with",
  "from",
  "by",
  "and",
  "then",
  "please",
  "my",
  "our",
  "all",
]);

const ID_WORD = /^t\d{4}(\.\d{3})?$/;

/** The words of a text: lower-case, punctuation and filler removed, at most MAX_TEXT_LENGTH characters read. */
export function words(text: string): string[] {
  return text
    .slice(0, MAX_TEXT_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w !== "" && !FILLER.has(w));
}

/** Where `phrase` starts in `tokens`, each of its words matching the start of a token; -1 for nowhere. */
function find(tokens: readonly string[], phrase: readonly string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => tokens[i + j]?.startsWith(w))) return i;
  }
  return -1;
}

const phrases = (list: readonly string[]): string[][] =>
  list.map((s) => words(s)).filter((p) => p.length > 0);

/** The role the nearest hint word names that the technique can be aimed at, or undefined. */
function roleFor(
  technique: TechniqueEntry,
  hints: readonly string[],
  ctx: MapperContext,
): string | undefined {
  const admitted = validTargets(technique, ctx);
  for (const hint of hints) {
    for (const role of TARGET_HINTS[hint] ?? []) {
      if (admitted.some((n) => n.roles.includes(role))) return role;
    }
  }
  return undefined;
}

export function mapKeywords(text: string, ctx: MapperContext): MapResult {
  const tokens = words(text);
  if (tokens.length === 0) {
    return {
      intents: [],
      source: "keyword",
      note: "Type what you want to try, for example: phishing to the dispatcher.",
    };
  }
  const consumed = new Set<number>();
  const mark = (at: number, length: number): void => {
    for (let i = at; i < at + length; i++) consumed.add(i);
  };

  const hits: { technique: TechniqueEntry; at: number }[] = [];
  for (const technique of ctx.techniques) {
    let first = -1;
    tokens.forEach((token, i) => {
      if (!ID_WORD.test(token)) return;
      const upper = token.toUpperCase();
      if (technique.id.toUpperCase() !== upper && technique.legacyId !== upper) return;
      mark(i, 1);
      if (first === -1 || i < first) first = i;
    });
    for (const phrase of phrases(SYNONYMS[technique.id] ?? [])) {
      const at = find(tokens, phrase);
      if (at === -1) continue;
      mark(at, phrase.length);
      if (first === -1 || at < first) first = at;
    }
    if (first !== -1) hits.push({ technique, at: first });
  }
  hits.sort((a, b) => a.at - b.at);

  const hinted: { hint: string; at: number }[] = [];
  for (const hint of Object.keys(TARGET_HINTS)) {
    for (const phrase of phrases([hint])) {
      const at = find(tokens, phrase);
      if (at === -1) continue;
      mark(at, phrase.length);
      hinted.push({ hint, at });
    }
  }
  const hints = hinted.sort((a, b) => a.at - b.at).map((h) => h.hint);

  const raw: Intent[] = hits.map(({ technique }) => {
    const role = roleFor(technique, hints, ctx);
    return role === undefined
      ? { technique: technique.id }
      : { technique: technique.id, target: { role } };
  });
  const { intents } = validateIntents(raw, ctx);

  const unmatched = tokens
    .filter((_, i) => !consumed.has(i))
    .map((w) => (w.length > 24 ? `${w.slice(0, 24)}...` : w))
    .slice(0, 8);
  const result: MapResult = { intents, source: "keyword" };
  if (unmatched.length > 0) result.unmatched = unmatched;
  if (intents.length === 0) {
    result.note =
      "Nothing matched. Try a technique name, an ID such as T0865, or words like phishing, vpn, scan, spoof.";
  } else if (unmatched.length > 0) {
    result.note = `Ignored: ${unmatched.join(", ")}.`;
  }
  return result;
}

export const keywordMapper: TechniqueMapper = {
  map: (text, ctx) => Promise.resolve(mapKeywords(text, ctx)),
};
