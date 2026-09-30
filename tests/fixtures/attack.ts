import { network } from "../../src/content/network";
import { phishingDispatcher } from "../../src/content/scenarios/phishing-dispatcher";
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

export const scenario = phishingDispatcher;

/** The scenario's world at tick 0 with its recorded seed. */
export const startWorld = (): World => createWorld(network, scenario.seed);

/** The tick of the last action of the scenario. */
export const lastLaunchTick = Math.max(...scenario.actions.map((x) => x.t));

export function nodeOf(world: World, id: string): World["nodes"][number] {
  const node = world.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}
