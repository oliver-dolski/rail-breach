#!/usr/bin/env node
// Regenerates public/fallback.svg, the still shown when WebGL2 is unavailable, from
// the layout and content. Run it after changing src/content/layout.ts; the fallback
// test fails until the committed file matches a fresh build.
//
// Usage: node scripts/make-fallback.mjs        (npm run fallback:regen)

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const { layout } = await server.ssrLoadModule("/src/content/layout.ts");
  const { network } = await server.ssrLoadModule("/src/content/network.ts");
  const { buildFallbackSvg } = await server.ssrLoadModule("/src/render/fallbackSvg.ts");
  const file = join(root, "public", "fallback.svg");
  writeFileSync(file, buildFallbackSvg(layout, network));
  console.log(`fallback still -> ${file}`);
} finally {
  await server.close();
}
