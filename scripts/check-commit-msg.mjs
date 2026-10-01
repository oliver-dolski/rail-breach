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
//
// The rules themselves live in lib/hygiene.mjs, shared with the history scan.

import { readFileSync } from "node:fs";
import { checkMessage, denyRules, MESSAGE_RULES, readDenyList } from "./lib/hygiene.mjs";

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
  rules = [...MESSAGE_RULES, ...denyRules(readDenyList(process.argv[3]))];
} catch {
  console.error(`check-commit-msg: cannot read deny list ${process.argv[3]}`);
  process.exit(2);
}

const problems = checkMessage(text, rules).map((p) => `  line ${p.line}: ${p.rule}`);

if (problems.length > 0) {
  console.error("Commit rejected by the repository rules:");
  for (const p of problems) console.error(p);
  console.error("Remove the trailer or banner, and use a plain hyphen instead of a long dash.");
  process.exit(1);
}
