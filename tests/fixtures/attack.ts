import { network } from "../../src/content/network";
import { phishingDispatcher, type Scenario } from "../../src/content/scenarios";
import { techniques } from "../../src/content/techniques";
import type { Content } from "../../src/content/types";
import type { TimedAction } from "../../src/core/replay/recording";
import type { SimEvent } from "../../src/core/sim/events";
import { buildIndex, type Index } from "../../src/core/sim/model";
import { step } from "../../src/core/sim/step";
import { createWorld, type World } from "../../src/core/sim/world";

/** Index over the fictional network with the technique catalogue and the safety check on. */
export function networkIndex(content: Content = network): Index {
  return buildIndex(content, { techniques, checkInvariants: true });
}

/** A copy of the content in which one link no longer carries one protocol. */
export function withoutProtocol(linkId: string, protocol: string): Content {
  return {
    ...network,
    links: network.links.map((link) =>
      link.id === linkId
        ? { ...link, protocols: link.protocols.filter((p) => p !== protocol) }
        : link,
    ),
  };
}

export interface Run {
  world: World;
  events: SimEvent[];
}

/**
 * Steps the world up to and including `toTick`, feeding the timed actions that
 * fall due. `indexAt` may swap the index between ticks to model a change in
 * the network while an operation is in flight.
 */
export function run(
  world: World,
  indexAt: Index | ((tick: number) => Index),
  actions: readonly TimedAction[],
  toTick: number,
): Run {
  let current = world;
  const events: SimEvent[] = [];
  for (let tick = world.tick + 1; tick <= toTick; tick++) {
    const due = actions.filter((x) => x.t === tick).map((x) => x.a);
    const index = typeof indexAt === "function" ? indexAt(tick) : indexAt;
    const result = step(current, due, index);
    current = result.world;
    events.push(...result.events);
  }
  return { world: current, events };
}

/**
 * The phishing scenario as the engine tests use it: its attack chain only. The recording
 * also starts with two IDS sensors already in place; tests that place defenses themselves,
 * or count them, rely on the bare chain, so those placements are left out here and
 * covered where the recording itself is tested.
 */
export const scenario: Scenario = {
  ...phishingDispatcher,
  actions: phishingDispatcher.actions.filter((x) => x.a.type === "technique.launch"),
};

/** The scenario's world at tick 0 with its recorded seed. */
export const startWorld = (): World => createWorld(network, scenario.seed);

/** The tick of the first and of the last action of the scenario. */
export const firstLaunchTick = Math.min(...scenario.actions.map((x) => x.t));
export const lastLaunchTick = Math.max(...scenario.actions.map((x) => x.t));

let warm: World | undefined;
/**
 * The scenario's world at its start tick, before any action. The quiet stretch
 * runs once per test file and the result is reused: step never mutates a world.
 */
export function warmWorld(index: Index): World {
  warm ??= run(startWorld(), index, [], scenario.startTick).world;
  return warm;
}

export function nodeOf(world: World, id: string): World["nodes"][number] {
  const node = world.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

/** A technique launch with the attacker's starting position: footholds and discovered nodes. */
export interface Launch {
  technique: string;
  target: string;
  foothold: string[];
  discovered: string[];
}

/** The fictional network at tick 0 with the launch's footholds and discoveries in place. */
export function prepared(launch: Launch, seed: number): World {
  const world = createWorld(network, seed);
  for (const id of launch.foothold) nodeOf(world, id).integrity = 1;
  for (const id of launch.discovered) nodeOf(world, id).discovered = true;
  return world;
}

export const launchAction = (launch: Launch, t = 1): TimedAction => ({
  t,
  a: { type: "technique.launch", technique: launch.technique, target: launch.target },
});

/** The first of 40 seeds whose dice let the launch apply `effect`, found by running it. */
export function winningSeed(launch: Launch, effect: string, index: Index): number {
  for (let seed = 0; seed < 40; seed++) {
    const { events } = run(prepared(launch, seed), index, [launchAction(launch)], 400);
    if (events.some((e) => e.k === "effect.applied" && e.effect === effect)) return seed;
  }
  throw new Error(`no seed lets ${launch.technique} succeed`);
}
