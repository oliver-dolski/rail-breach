#!/usr/bin/env node
// Commit message hygiene, called by .githooks/commit-msg with the message file.
// Rejects co-author trailers, generated-with banners and long dashes. Exit 1
// on a violation, 2 on a usage or read error, 0 when the message is clean.
//
// An optional second argument names a deny list of extra phrases, one per
// line, matched case-insensitively with any run of whitespace between words.
// It lives outside the repository (the hook passes .git/info/commit-msg-deny),
// so machine-specific phrases never become part of the tracked rules. A
// missing deny list is not an error.

import { existsSync, readFileSync } from "node:fs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RULES = [
  { name: "co-author trailer", re: /^\s*co-authored-by\s*:/i },
  { name: "generated-with banner", re: /generated with/i },
  { name: "em dash", re: new RegExp(String.fromCharCode(0x2014)) },
  { name: "en dash", re: new RegExp(String.fromCharCode(0x2013)) },
];

/** Drops what git itself discards: comment lines and everything below the scissors line. */
function messageBody(text) {
  const beforeScissors = text.split(/^# -+ >8 -+\s*$/m)[0] ?? "";
  return beforeScissors.split(/\r?\n/).filter((line) => !line.startsWith("#"));
}

/** Turns each non-empty, non-comment line of the deny list into a rule. */
function denyRules(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((phrase) => ({
      name: "denied phrase",
      re: new RegExp(phrase.split(/\s+/).map(escapeRe).join("\\s+"), "i"),
    }));
}

const file = process.argv[2];
if (!file) {
  console.error("usage: check-commit-msg.mjs <message-file> [deny-list]");
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`check-commit-msg: cannot read ${file}`);
  process.exit(2);
}

let rules;
try {
  rules = [...RULES, ...denyRules(process.argv[3])];
} catch {
  console.error(`check-commit-msg: cannot read deny list ${process.argv[3]}`);
  process.exit(2);
}

const problems = [];
messageBody(text).forEach((line, index) => {
  for (const rule of rules) {
    if (rule.re.test(line)) problems.push(`  line ${index + 1}: ${rule.name}`);
  }
});

if (problems.length > 0) {
  console.error("Commit rejected by the repository rules:");
  for (const p of problems) console.error(p);
  console.error("Remove the trailer or banner, and use a plain hyphen instead of a long dash.");
  process.exit(1);
}
