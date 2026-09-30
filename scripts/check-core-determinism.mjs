#!/usr/bin/env node
// Determinism gate for the pure core: fails when a file under src/core uses an
// API whose result depends on the host, the clock or the engine build.
//
// Comments, string contents and regex literals are blanked before matching, so
// prose that names a banned API does not trip the gate while a call inside a
// template expression still does. Whether a "/" opens a regex or divides is
// decided from the token before it: a heuristic, not a parser, so a misjudged
// "/" can hide or invent a finding on that line only.
//
// The gate is lexical, so it closes the obvious ways around it rather than
// proving anything: the name Math may only appear as Math.<exact member>, which
// also rules out aliasing (const M = Math), destructuring and computed access;
// globalThis, Reflect, Intl, eval, the Function constructor and the
// locale-dependent toLocale* methods are banned outright. Anything cleverer than
// that needs a real review.
//
// Usage: node scripts/check-core-determinism.mjs [dir]   (default: src/core)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Math members whose result is exact on every engine. */
const EXACT_MATH = "floor|ceil|round|trunc|sign|abs|min|max|imul|clz32|fround|sqrt";

const RULES = [
  { name: "Math.random (unseeded randomness)", re: /\bMath\s*\.\s*random\b/ },
  { name: "Date (wall clock)", re: /\bDate\b/ },
  { name: "performance (timer)", re: /\bperformance\b/ },
  { name: "crypto (host randomness)", re: /\bcrypto\b/ },
  {
    name: "transcendental Math function (result differs across engines)",
    re: /\bMath\s*\.\s*(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|pow|log|log2|log10|log1p|cbrt|hypot)\b/,
  },
  { name: "computed Math access (hides the banned names)", re: /\bMath\s*\[/ },
  {
    name: "Math used other than as Math.<exact member> (an alias or destructuring hides the names)",
    re: new RegExp(`\\bMath\\b(?!\\s*\\.\\s*(?:${EXACT_MATH})\\b)`),
  },
  { name: "globalThis (reaches every banned global)", re: /\bglobalThis\b/ },
  { name: "Reflect (computed access to banned names)", re: /\bReflect\b/ },
  { name: "Intl (host locale data)", re: /\bIntl\b/ },
  { name: "toLocale* (host locale data)", re: /\.\s*toLocale\w*\s*\(/ },
  { name: "eval or Function constructor (hides the banned names)", re: /\b(?:eval|Function)\s*\(/ },
];

const REGEX_PRECEDING_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "instanceof",
  "yield",
  "await",
]);

/** Whether a "/" after the code in `before` starts a regex literal rather than dividing. */
function startsRegex(before) {
  const text = before.trimEnd();
  const last = text[text.length - 1];
  if (last === undefined) return true;
  if (last === ")" || last === "]" || last === "}") return false;
  if (/[\w$]/.test(last)) return REGEX_PRECEDING_WORDS.has(text.match(/[\w$]+$/)[0]);
  if (text.endsWith("++") || text.endsWith("--")) return false;
  return true;
}

/** Replaces comments and string contents with spaces, keeping line structure. */
export function stripNonCode(src) {
  const blank = (ch) => (ch === "\n" || ch === "\r" ? ch : " ");
  const stack = []; // { type: "tpl" } | { type: "expr", depth: number }
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = src[i + 1] ?? "";
    if (top?.type === "tpl") {
      if (c === "\\") {
        out += ` ${blank(d || " ")}`;
        i += 2;
      } else if (c === "`") {
        out += c;
        stack.pop();
        i++;
      } else if (c === "$" && d === "{") {
        out += "${";
        stack.push({ type: "expr", depth: 0 });
        i += 2;
      } else {
        out += blank(c);
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += blank(src[i]);
      continue;
    }
    if (c === "/" && startsRegex(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (ch === "]") inClass = false;
        } else if (ch === "[") {
          inClass = true;
        } else if (ch === "/") {
          break;
        }
        j++;
      }
      if (j < n && src[j] === "/") {
        out += `/${" ".repeat(j - i - 1)}/`;
        i = j + 1;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          out += " ";
          i++;
          if (i < n) {
            out += blank(src[i]);
            i++;
          }
        } else {
          out += " ";
          i++;
        }
      }
      if (i < n && src[i] === c) {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "`") {
      out += c;
      stack.push({ type: "tpl" });
      i++;
      continue;
    }
    if (top?.type === "expr") {
      if (c === "{") {
        top.depth++;
      } else if (c === "}") {
        if (top.depth === 0) {
          stack.pop();
        } else {
          top.depth--;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.argv[2] ?? join(here, "..", "src", "core"));

  let files;
  try {
    files = listTsFiles(root);
  } catch {
    console.error(`check-core-determinism: cannot read ${root}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`check-core-determinism: no .ts files under ${root}; refusing to pass vacuously`);
    return 2;
  }

  const violations = [];
  for (const file of files) {
    const lines = stripNonCode(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          const shown = relative(process.cwd(), file).split("\\").join("/");
          violations.push(`${shown}:${index + 1}: ${rule.name}`);
          break;
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error("Non-deterministic API in the core:");
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }
  console.log(`core determinism: ${files.length} files clean`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
