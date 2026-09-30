#!/usr/bin/env node
// Determinism gate for the pure core: fails when a file under src/core uses an
// API whose result depends on the host, the clock or the engine build.
//
// Comments and string contents are blanked before matching, so prose that names
// a banned API does not trip the gate while a call inside a template expression
// still does. Regex literals containing a quote are not understood; the core has
// none, and a false positive there is the safe direction.
//
// Usage: node scripts/check-core-determinism.mjs [dir]   (default: src/core)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = [
  { name: "Math.random (unseeded randomness)", re: /\bMath\s*\.\s*random\b/ },
  { name: "Date (wall clock)", re: /\bDate\b/ },
  { name: "performance.* (timer)", re: /\bperformance\s*\./ },
  { name: "crypto.* (host randomness)", re: /\bcrypto\s*\./ },
  {
    name: "transcendental Math function (result differs across engines)",
    re: /\bMath\s*\.\s*(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|pow|log|log2|log10|log1p|cbrt|hypot)\b/,
  },
  { name: "computed Math access (hides the banned names)", re: /\bMath\s*\[/ },
];

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
