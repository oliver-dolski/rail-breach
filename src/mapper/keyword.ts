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

interface Token {
  word: string;
  filler: boolean;
}

/** Every word of a text in order, lower-case and without punctuation, filler flagged but kept. */
function tokenize(text: string): Token[] {
  return text
    .slice(0, MAX_TEXT_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w !== "")
    .map((word) => ({ word, filler: FILLER.has(word) }));
}

/** The words of a text: lower-case, punctuation and filler removed, at most MAX_TEXT_LENGTH characters read. */
export function words(text: string): string[] {
  return tokenize(text)
    .filter((t) => !t.filler)
    .map((t) => t.word);
}

/**
 * What the nothing-matched note suggests. Each one is a phrase the matcher maps (a test
 * pins that), and bare "spoof" is not among them: it would be ambiguous between a spoofed
 * command message and spoofed reports.
 */
export const NOTHING_MATCHED_EXAMPLES: readonly string[] = [
  "phishing",
  "vpn",
  "scan the network",
  "spoof the reports",
];

/** Words up to this long must be the whole word (plus an ending), not just the start of one. */
const SHORT_WORD = 4;

/**
 * Whether a token is `word` in the viewer's text. A longer word matches the start of a token
 * ("phish" takes "phishing"); a short one would match far too much that way ("jam" and
 * "jamaica", "scan" and "scandal"), so it takes only the word itself and its plain endings
 * ("jams", "jammed", "jamming").
 */
function matches(token: string, word: string): boolean {
  if (word.length > SHORT_WORD) return token.startsWith(word);
  if (!token.startsWith(word)) return false;
  const rest = token.slice(word.length);
  const last = word.slice(-1);
  return ["", "s", "es", "d", "ed", "ing", `${last}ing`, `${last}ed`].includes(rest);
}

/** Where `phrase` starts in `tokens`, each of its words matching a token; -1 for nowhere. */
function find(tokens: readonly string[], phrase: readonly string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => matches(tokens[i + j] ?? "", w))) return i;
  }
  return -1;
}

/**
 * A phrase to look for. Most are matched on the text without its filler words, so "spoof the
 * reports" finds "spoof reports". A phrase that is only one word once its filler is gone
 * ("log in" is "log") would match any text that merely says that word, so it is matched on
 * the words as typed instead, with its filler words exactly as given.
 */
interface Phrase {
  words: string[];
  /** Set for a phrase that must be matched with its filler words, as typed. */
  typed?: Token[];
}

function toPhrase(entry: string): Phrase | undefined {
  const typed = tokenize(entry);
  const content = typed.filter((t) => !t.filler).map((t) => t.word);
  if (content.length === 0) return undefined;
  return content.length === 1 && typed.length > 1 ? { words: content, typed } : { words: content };
}

const phrases = (list: readonly string[]): Phrase[] =>
  list.map(toPhrase).filter((p): p is Phrase => p !== undefined);

/** The text as typed: every token, and the index of each among the content words (-1 for filler). */
type Typed = readonly { token: Token; content: number }[];

interface Found {
  /** Index among the content words of the first word of the match. */
  at: number;
  /** The content words the match covers. */
  covers: number[];
}

/** Where `phrase` stands in the text, or undefined. */
function locate(phrase: Phrase, tokens: readonly string[], typed: Typed): Found | undefined {
  if (phrase.typed === undefined) {
    const at = find(tokens, phrase.words);
    if (at === -1) return undefined;
    return { at, covers: phrase.words.map((_, j) => at + j) };
  }
  const want = phrase.typed;
  for (let i = 0; i + want.length <= typed.length; i++) {
    const window = typed.slice(i, i + want.length);
    const same = want.every((w, j) => {
      const got = window[j]?.token;
      if (got === undefined) return false;
      return w.filler ? got.word === w.word : matches(got.word, w.word);
    });
    if (!same) continue;
    const covers = window.map((t) => t.content).filter((c) => c >= 0);
    return { at: covers[0] ?? 0, covers };
  }
  return undefined;
}

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

/**
 * Words and marks that say "and after that". What follows starts a new step, so a technique
 * named again in it is a repeat the viewer meant ("RDP to the jump host, then RDP to the
 * engineering workstation"), where the same technique named twice in one breath ("vpn and
 * remote access") is one step.
 */
const SEQUENCE = /[;\n]|\.(?=\s|$)|\b(?:then|next|afterwards?|after that|followed by)\b/i;

/** One stretch of text between sequence words, with its own filler-free words. */
interface Clause {
  tokens: string[];
  typed: Typed;
  /** Index of the clause's first content word among all the text's content words. */
  offset: number;
}

function clausesOf(text: string): Clause[] {
  const clauses: Clause[] = [];
  let offset = 0;
  for (const part of text.slice(0, MAX_TEXT_LENGTH).split(SEQUENCE)) {
    const all = tokenize(part);
    const tokens = all.filter((t) => !t.filler).map((t) => t.word);
    if (tokens.length === 0) continue;
    let n = 0;
    const typed: Typed = all.map((token) => ({ token, content: token.filler ? -1 : n++ }));
    clauses.push({ tokens, typed, offset });
    offset += tokens.length;
  }
  return clauses;
}

export function mapKeywords(text: string, ctx: MapperContext): MapResult {
  const clauses = clausesOf(text);
  const tokens = clauses.flatMap((c) => c.tokens);
  if (tokens.length === 0) {
    return {
      intents: [],
      source: "keyword",
      note: "Type what you want to try, for example: phishing to the dispatcher.",
    };
  }
  const consumed = new Set<number>();
  const mark = (covers: readonly number[]): void => {
    for (const i of covers) consumed.add(i);
  };
  /** Where `phrase` stands in the clause, counted among all the text's words. */
  const within = (phrase: Phrase, clause: Clause): Found | undefined => {
    const found = locate(phrase, clause.tokens, clause.typed);
    if (found === undefined) return undefined;
    return { at: found.at + clause.offset, covers: found.covers.map((c) => c + clause.offset) };
  };

  // A technique is one step for every clause that names it, and its place is its first mention there.
  const hits: { technique: TechniqueEntry; at: number; clause: number }[] = [];
  for (const technique of ctx.techniques) {
    clauses.forEach((clause, ci) => {
      let first = -1;
      clause.tokens.forEach((token, i) => {
        if (!ID_WORD.test(token)) return;
        const upper = token.toUpperCase();
        if (technique.id.toUpperCase() !== upper && technique.legacyId !== upper) return;
        mark([clause.offset + i]);
        if (first === -1 || clause.offset + i < first) first = clause.offset + i;
      });
      for (const phrase of phrases(SYNONYMS[technique.id] ?? [])) {
        const found = within(phrase, clause);
        if (found === undefined) continue;
        mark(found.covers);
        if (first === -1 || found.at < first) first = found.at;
      }
      if (first !== -1) hits.push({ technique, at: first, clause: ci });
    });
  }
  hits.sort((a, b) => a.at - b.at);

  const hinted: { hint: string; at: number; clause: number }[] = [];
  for (const hint of Object.keys(TARGET_HINTS)) {
    for (const phrase of phrases([hint])) {
      clauses.forEach((clause, ci) => {
        const found = within(phrase, clause);
        if (found === undefined) return;
        mark(found.covers);
        hinted.push({ hint, at: found.at, clause: ci });
      });
    }
  }
  hinted.sort((a, b) => a.at - b.at);

  const raw: Intent[] = hits.map(({ technique, clause }) => {
    // The places named in the step's own clause come first, then the rest of the text.
    const near = [
      ...hinted.filter((h) => h.clause === clause),
      ...hinted.filter((h) => h.clause !== clause),
    ].map((h) => h.hint);
    const role = roleFor(technique, near, ctx);
    return role === undefined
      ? { technique: technique.id }
      : { technique: technique.id, target: { role } };
  });
  const { intents } = validateIntents(raw, ctx, { keepRepeats: true });

  const unmatched = tokens
    .filter((_, i) => !consumed.has(i))
    .map((w) => (w.length > 24 ? `${w.slice(0, 24)}...` : w))
    .slice(0, 8);
  const result: MapResult = { intents, source: "keyword" };
  if (unmatched.length > 0) result.unmatched = unmatched;
  if (intents.length === 0) {
    result.note = `Nothing matched. Try a technique name, an ID such as T0865, or words like ${NOTHING_MATCHED_EXAMPLES.join(", ")}.`;
  } else if (unmatched.length > 0) {
    result.note = `Ignored: ${unmatched.join(", ")}.`;
  }
  return result;
}

export const keywordMapper: TechniqueMapper = {
  map: (text, ctx) => Promise.resolve(mapKeywords(text, ctx)),
};
