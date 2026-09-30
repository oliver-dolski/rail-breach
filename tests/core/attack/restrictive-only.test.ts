import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { techniques } from "../../../src/content/techniques";
import { applyEffect } from "../../../src/core/attack/effects";
import type { Effect } from "../../../src/core/attack/types";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import type { Aspect, SimEvent } from "../../../src/core/sim/events";
import { step } from "../../../src/core/sim/step";
import { cloneWorld, createWorld, type World } from "../../../src/core/sim/world";
import { networkIndex } from "../../fixtures/attack";

const index = networkIndex();

/** Every distinct effect any registered technique can apply, straight from the registry. */
const effects: Effect[] = [
  ...new Map(techniques.flatMap((t) => t.effects).map((e) => [JSON.stringify(e), e])).values(),
];
const nodeIds = network.nodes.map((n) => n.id).sort();

const SEEDS = [0, 1, 2, 3, 4, 5];
const WARM_UP_TICKS = (seed: number): number => 300 + seed * 250; // trains at different places
const OBSERVE_TICKS = 400;

/** Higher means more permissive. Dark counts as stop, as a driver treats it. */
const rank: Record<Aspect, number> = { dark: 0, stop: 0, caution: 1, proceed: 2 };

function advance(world: World, ticks: number): { world: World; events: SimEvent[] } {
  let current = world;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const result = step(current, [], index);
    current = result.world;
    events.push(...result.events);
  }
  return { world: current, events };
}

const warmed = new Map<number, World>();
function warmWorld(seed: number): World {
  let world = warmed.get(seed);
  if (world === undefined) {
    world = advance(createWorld(network, seed), WARM_UP_TICKS(seed)).world;
    warmed.set(seed, world);
  }
  return world;
}

const baselines = new Map<number, { aspects: Aspect[]; routes: Set<string>; overruns: number }>();
function baseline(seed: number) {
  let cached = baselines.get(seed);
  if (cached === undefined) {
    const oneTick = step(warmWorld(seed), [], index);
    const later = advance(warmWorld(seed), OBSERVE_TICKS);
    cached = {
      aspects: deriveAspects(oneTick.world, index),
      routes: new Set(
        oneTick.events.flatMap((e) => (e.k === "route.set" ? [`${e.il}/${e.route}`] : [])),
      ),
      overruns: later.events.filter((e) => e.k === "train.overran").length,
    };
    baselines.set(seed, cached);
  }
  return cached;
}

const CYBER_FIELDS = ["integrity", "discovered", "cmdBlocked", "controlDenied"] as const;

/** The attacked world may differ from the original only by monotone changes of the cyber fields. */
function expectOnlyMonotoneCyberChanges(before: World, after: World): void {
  const { nodes: nodesBefore, ...restBefore } = before;
  const { nodes: nodesAfter, ...restAfter } = after;
  expect(restAfter).toEqual(restBefore);
  expect(nodesAfter.map((n) => n.id)).toEqual(nodesBefore.map((n) => n.id));
  nodesAfter.forEach((node, i) => {
    const old = nodesBefore[i];
    if (old === undefined) throw new Error("node list changed");
    for (const key of Object.keys(node) as (keyof typeof node)[]) {
      if ((CYBER_FIELDS as readonly string[]).includes(key)) continue;
      expect(node[key], `${node.id}.${key}`).toEqual(old[key]);
    }
    expect(node.integrity, `${node.id}.integrity`).toBeGreaterThanOrEqual(old.integrity);
    for (const flag of ["discovered", "cmdBlocked", "controlDenied"] as const) {
      // A flag may turn on; it never turns off.
      if (old[flag]) expect(node[flag], `${node.id}.${flag}`).toBe(true);
    }
  });
}

function expectNoMorePermissive(attacked: World, seed: number): void {
  const base = baseline(seed);
  const result = step(attacked, [], index);

  const aspects = deriveAspects(result.world, index);
  aspects.forEach((aspect, i) => {
    const was = base.aspects[i];
    if (was === undefined) throw new Error("aspect list changed");
    expect(rank[aspect], `signal #${i} shows ${aspect}, baseline ${was}`).toBeLessThanOrEqual(
      rank[was],
    );
  });

  // The attack may prevent a route from being set; it may never cause one to be set.
  for (const event of result.events) {
    if (event.k === "route.set") expect(base.routes.has(`${event.il}/${event.route}`)).toBe(true);
  }
}

describe("the technique registry", () => {
  it("has effects to enumerate", () => {
    expect(effects.length).toBeGreaterThanOrEqual(4);
  });

  it("names no effect that could grant, clear, move or release anything", () => {
    const forbidden =
      /proceed|clear|move|grant|release|unlock|open|allow|force|set(?:Aspect|Route|Point|Lock)/i;
    for (const effect of effects) expect(effect.k, effect.k).not.toMatch(forbidden);
    // The type itself, not only the members in use: read the union out of the source.
    const source = readFileSync("src/core/attack/types.ts", "utf8");
    const union = /export type Effect =([\s\S]*?);\n/.exec(source)?.[1] ?? "";
    const declared = [...union.matchAll(/k:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(declared.length).toBeGreaterThanOrEqual(4);
    for (const name of declared) expect(name, name).not.toMatch(forbidden);
    // Every declared kind is used by some technique or is reviewed here on purpose.
    expect(new Set(effects.map((e) => e.k))).toEqual(new Set(declared));
  });
});

describe("the effect code cannot reach the railway", () => {
  const code = (path: string): string =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  const worldFields = (source: string): Set<string> =>
    new Set([...source.matchAll(/\bworld\.(\w+)/g)].map((m) => m[1] ?? ""));
  const assigned = (source: string): Set<string> =>
    new Set([...source.matchAll(/\b\w+\.(\w+)\s*(?:=|\+=|-=)(?!=)/g)].map((m) => m[1] ?? ""));

  it("applyEffect reads only world.nodes and writes only the four cyber fields", () => {
    const source = code("src/core/attack/effects.ts");
    expect([...worldFields(source)].sort()).toEqual(["nodes"]);
    expect([...assigned(source)].sort()).toEqual([...CYBER_FIELDS].sort());
  });

  it("the operation engine touches only the operation list and node dice keys", () => {
    const source = code("src/core/attack/ops.ts");
    const allowed = new Set(["nodes", "ops", "opSeq", "seed", "tick"]);
    for (const field of worldFields(source)) expect(allowed.has(field), field).toBe(true);
    for (const field of assigned(source)) {
      expect(["opSeq", "doneAt", "hop", "ops"]).toContain(field);
    }
  });
});

describe("no effect, on any node, at any seed, makes the railway more permissive", () => {
  for (const effect of effects) {
    it(`${effect.k}${JSON.stringify(effect)}: one tick later, and over ${OBSERVE_TICKS} ticks`, () => {
      for (const seed of SEEDS) {
        const before = warmWorld(seed);
        for (const id of nodeIds) {
          const attacked = cloneWorld(before);
          applyEffect(attacked, index, id, effect);
          expectOnlyMonotoneCyberChanges(before, attacked);
          expectNoMorePermissive(attacked, seed);

          // Steps with the safety invariant asserted on every tick; a violation throws.
          const later = advance(attacked, OBSERVE_TICKS);
          const overruns = later.events.filter((e) => e.k === "train.overran").length;
          expect(overruns, `${id} seed ${seed}`).toBeLessThanOrEqual(baseline(seed).overruns);
        }
      }
    });
  }

  it("holds with every effect applied to every node at once", () => {
    for (const seed of SEEDS) {
      const attacked = cloneWorld(warmWorld(seed));
      for (const id of nodeIds)
        for (const effect of effects) applyEffect(attacked, index, id, effect);
      expectOnlyMonotoneCyberChanges(warmWorld(seed), attacked);
      expectNoMorePermissive(attacked, seed);
      const later = advance(attacked, OBSERVE_TICKS);
      // Every route request is refused, so nothing new is ever locked: trains only queue.
      expect(later.events.filter((e) => e.k === "route.set")).toEqual([]);
      expect(later.events.filter((e) => e.k === "train.overran").length).toBeLessThanOrEqual(
        baseline(seed).overruns,
      );
    }
  });
});
