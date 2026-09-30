import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { stateHash } from "../../../src/core/hash";
import type { TimedAction } from "../../../src/core/replay/recording";
import { DENIAL_OF_CONTROL_RECOVER_TICKS } from "../../../src/core/sim/constants";
import type { SimEvent } from "../../../src/core/sim/events";
import { createWorld, type World } from "../../../src/core/sim/world";
import { networkIndex, nodeOf, run } from "../../fixtures/attack";

// The index checks the safety invariant after every step, so every run below
// asserts it on every tick: a violation throws out of step().
const index = networkIndex();

const SEEDS = Array.from({ length: 40 }, (_, i) => i);

const roundTrip = (world: World): World => JSON.parse(JSON.stringify(world)) as World;

interface Launch {
  technique: string;
  target: string;
  foothold: string[];
  discovered: string[];
}

const T0813: Launch = {
  technique: "T0813",
  target: "dispatch-hmi-2",
  foothold: ["tms-server"],
  discovered: [],
};

function prepared(launch: Launch, seed: number): World {
  const world = createWorld(network, seed);
  for (const id of launch.foothold) nodeOf(world, id).integrity = 1;
  for (const id of launch.discovered) nodeOf(world, id).discovered = true;
  return world;
}

const launchAction = (launch: Launch, t = 1): TimedAction => ({
  t,
  a: { type: "technique.launch", technique: launch.technique, target: launch.target },
});

/** The first seed whose dice let the launch succeed, found by running it. */
function winningSeed(launch: Launch, effect: string): number {
  for (const seed of SEEDS) {
    const { events } = run(prepared(launch, seed), index, [launchAction(launch)], 400);
    if (events.some((e) => e.k === "effect.applied" && e.effect === effect)) return seed;
  }
  throw new Error(`no seed lets ${launch.technique} succeed`);
}

const cleared = (events: SimEvent[]) =>
  events.filter((e): e is Extract<SimEvent, { k: "effect.cleared" }> => e.k === "effect.cleared");

describe("T0813 Denial of Control lifts on its own", () => {
  const seed = winningSeed(T0813, "denyControl");
  const actions = [launchAction(T0813)];

  const landing = run(prepared(T0813, seed), index, actions, 400);
  const landedAt = landing.events.find(
    (e) => e.k === "effect.applied" && e.effect === "denyControl",
  )?.tick;

  it("lands, is held for the recovery period and lifts on the exact tick", () => {
    expect(landedAt).toBeDefined();
    if (landedAt === undefined) return;
    const recoverAt = landedAt + DENIAL_OF_CONTROL_RECOVER_TICKS;

    const hmi = nodeOf(landing.world, T0813.target);
    expect(hmi.controlDenied).toBe(true);
    expect(hmi.controlRecoverAt).toBe(recoverAt);

    // One tick short of the end the operators are still locked out, with no event yet.
    const before = run(landing.world, index, actions, recoverAt - 1);
    expect(nodeOf(before.world, T0813.target).controlDenied).toBe(true);
    expect(cleared(before.events)).toEqual([]);

    // The tick after brings control back and says so, once.
    const at = run(before.world, index, actions, recoverAt);
    const node = nodeOf(at.world, T0813.target);
    expect(node.controlDenied).toBe(false);
    expect(node.controlRecoverAt).toBe(0);
    expect(cleared(at.events)).toEqual([
      { k: "effect.cleared", tick: recoverAt, node: T0813.target, effect: "denyControl" },
    ]);

    // It stays lifted: nothing re-applies it.
    const later = run(at.world, index, actions, recoverAt + 300);
    expect(nodeOf(later.world, T0813.target).controlDenied).toBe(false);
    expect(cleared(later.events)).toEqual([]);
  });

  it("reaches the same world in one long advance and in short chunks with a JSON round-trip", () => {
    const TOTAL = 1500; // past landing plus the 1200-tick recovery period
    const start = prepared(T0813, seed);
    const whole = run(start, index, actions, TOTAL);

    let chunked = start;
    const chunkedEvents: SimEvent[] = [];
    for (let from = 0; from < TOTAL; from += 100) {
      const part = run(chunked, index, actions, from + 100);
      chunkedEvents.push(...part.events);
      chunked = roundTrip(part.world);
    }

    expect(cleared(whole.events)).toHaveLength(1);
    expect(nodeOf(whole.world, T0813.target).controlDenied).toBe(false);
    expect(stateHash(chunked)).toBe(stateHash(whole.world));
    expect(chunkedEvents).toEqual(whole.events);
  });

  it("does not shorten a denial that has no end of its own", () => {
    const world = prepared(T0813, seed);
    const hmi = nodeOf(world, T0813.target);
    hmi.controlDenied = true;
    hmi.controlRecoverAt = 0;
    const result = run(world, index, [], DENIAL_OF_CONTROL_RECOVER_TICKS + 50);
    expect(nodeOf(result.world, T0813.target).controlDenied).toBe(true);
    expect(cleared(result.events)).toEqual([]);
  });
});
