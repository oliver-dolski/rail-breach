#!/usr/bin/env node
// Size budget of the production build (UI-SPEC G16): `npm run build && npm run check:budget`.
//
// The phase may grow the JavaScript by 40 KiB and the stylesheet by 8 KiB over the certified
// board, and the build carries exactly one font file, the pinned display face. The script reads
// dist/assets, prints the three figures and exits 1 when a limit is broken or dist is missing.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Sizes of dist/assets at 8680694, the certified board this phase starts from. */
export const BASELINE_JS_BYTES = 213_980;
export const BASELINE_CSS_BYTES = 11_204;
export const JS_GROWTH_BYTES = 40_960;
export const CSS_GROWTH_BYTES = 8_192;
/** The pinned Space Grotesk file, space-grotesk-latin-wght-normal.woff2. */
export const FONT_BYTES = 22_288;

/**
 * Whether a build is inside the budget. `fonts` lists the size of every .woff2 file in the build.
 * Returns every broken limit, not only the first, so one run says everything that is wrong.
 */
export function budgetVerdict({ js, css, fonts }) {
  const reasons = [];
  const jsLimit = BASELINE_JS_BYTES + JS_GROWTH_BYTES;
  const cssLimit = BASELINE_CSS_BYTES + CSS_GROWTH_BYTES;
  if (js > jsLimit)
    reasons.push(`JavaScript is ${js} bytes, ${js - jsLimit} over the limit of ${jsLimit}`);
  if (css > cssLimit)
    reasons.push(`CSS is ${css} bytes, ${css - cssLimit} over the limit of ${cssLimit}`);
  if (fonts.length !== 1) {
    reasons.push(`the build must carry exactly one font file, it has ${fonts.length}`);
  } else if (fonts[0] !== FONT_BYTES) {
    reasons.push(`the font file is ${fonts[0]} bytes, the pinned face is ${FONT_BYTES}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Totals of dist/assets: bytes of every .js and every .css file, and the size of each .woff2. */
export function measure(assetsDir) {
  const sizes = { js: 0, css: 0, fonts: [] };
  for (const name of readdirSync(assetsDir).sort()) {
    const bytes = statSync(join(assetsDir, name)).size;
    if (name.endsWith(".js")) sizes.js += bytes;
    else if (name.endsWith(".css")) sizes.css += bytes;
    else if (name.endsWith(".woff2")) sizes.fonts.push(bytes);
  }
  return sizes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
  if (!existsSync(assets)) {
    console.error("dist/assets is missing: run npm run build first");
    process.exit(1);
  }
  const sizes = measure(assets);
  const verdict = budgetVerdict(sizes);
  console.log(
    `JS ${sizes.js} B (limit ${BASELINE_JS_BYTES + JS_GROWTH_BYTES}), CSS ${sizes.css} B (limit ${BASELINE_CSS_BYTES + CSS_GROWTH_BYTES}), fonts ${sizes.fonts.map((f) => `${f} B`).join(", ") || "none"}`,
  );
  for (const reason of verdict.reasons) console.error(`over budget: ${reason}`);
  console.log(verdict.ok ? "budget ok" : "budget FAILED");
  process.exit(verdict.ok ? 0 : 1);
}
