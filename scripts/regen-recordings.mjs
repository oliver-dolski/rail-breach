#!/usr/bin/env node
// Regenerates the committed session recordings by running each scenario through
// the real engine. Run it after any change that alters simulation results; the
// replay-hash test fails until the committed JSON matches a fresh capture.
//
// Usage: node scripts/regen-recordings.mjs        (npm run recordings:regen)

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
  const load = (path) => server.ssrLoadModule(path);
  const { network } = await load("/src/content/network.ts");
  const { techniques } = await load("/src/content/techniques/index.ts");
  const { scenarios } = await load("/src/content/scenarios/index.ts");
  const { validateScenario } = await load("/src/content/scenarios/validate.ts");
  const { buildIndex } = await load("/src/core/sim/model.ts");
  const { createWorld } = await load("/src/core/sim/world.ts");
  const { captureRecording } = await load("/src/core/replay/capture.ts");

  // The safety check stays on: a scenario that breaks the invariant cannot be recorded.
  const index = buildIndex(network, { techniques, checkInvariants: true });

  for (const scenario of scenarios) {
    validateScenario(scenario, network, techniques);
    const world = createWorld(network, scenario.seed);
    const recording = captureRecording(world, index, scenario.actions, scenario.durationTicks);
    const file = join(root, "src", "recordings", `${scenario.id}.json`);
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(
      `${scenario.id}: ${recording.actions.length} actions, ${recording.checkpoints.length} checkpoints -> ${file}`,
    );
  }
} finally {
  await server.close();
}
