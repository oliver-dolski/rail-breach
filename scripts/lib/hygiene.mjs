// Commit message rules and deny-list parsing, shared by the commit-msg hook
// (scripts/check-commit-msg.mjs) and the full-history scan (scripts/scan-history.mjs),
// so an old message is judged by exactly the rules a new one met at commit time.

import { existsSync, readFileSync } from "node:fs";

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const MESSAGE_RULES = [
  { name: "co-author trailer", re: /^\s*co-authored-by\s*:/i },
  { name: "generated-with banner", re: /generated with/i },
  { name: "em dash", re: new RegExp(String.fromCharCode(0x2014)) },
  { name: "en dash", re: new RegExp(String.fromCharCode(0x2013)) },
];

/** Drops what git itself discards: comment lines and everything below the scissors line. */
export function messageBody(text) {
  const beforeScissors = text.split(/^# -+ >8 -+\s*$/m)[0] ?? "";
  return beforeScissors.split(/\r?\n/).filter((line) => !line.startsWith("#"));
}

/** The non-empty, non-comment lines of a deny list with their 1-based line numbers. */
export function parseDenyEntries(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const phrase = raw.trim();
    if (phrase !== "" && !phrase.startsWith("#")) entries.push({ phrase, line: index + 1 });
  });
  return entries;
}

/** One phrase per non-empty, non-comment line. */
export function parseDenyList(text) {
  return parseDenyEntries(text).map((entry) => entry.phrase);
}

/** Reads a deny list. A missing file or no path is an empty list, a read error throws. */
export function readDenyList(path) {
  if (!path || !existsSync(path)) return [];
  return parseDenyList(readFileSync(path, "utf8"));
}

/** A phrase as a regex: case-insensitive by default, any whitespace run between words. */
export function phraseRegex(phrase, flags = "i") {
  return new RegExp(phrase.split(/\s+/).map(escapeRe).join("\\s+"), flags);
}

/** Turns deny-list phrases into message rules. */
export function denyRules(phrases) {
  return phrases.map((phrase) => ({ name: "denied phrase", re: phraseRegex(phrase) }));
}

/**
 * Checks a commit message line by line and returns `{ line, rule }` for each hit. The hook passes
 * the text of the message file, which git still has to clean up, so comment lines and the scissors
 * section are skipped. A stored message is already clean: with `verbatim` every line counts, so a
 * line that starts with # in history is judged like any other.
 */
export function checkMessage(text, rules, { verbatim = false } = {}) {
  const lines = verbatim ? text.split(/\r?\n/) : messageBody(text);
  const problems = [];
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.re.test(line)) problems.push({ line: index + 1, rule: rule.name });
    }
  });
  return problems;
}
