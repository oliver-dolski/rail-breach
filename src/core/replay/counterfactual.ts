import { stateHash } from "../hash";
import type { Index } from "../sim/model";
import { step } from "../sim/step";
import type { World } from "../sim/world";
import type { TimedAction } from "./recording";

/**
 * What a run came to, in the few numbers that matter when two runs are compared.
 * Derived from the events and the final world; nothing here is ever recorded.
 */
export interface Outcome {
  /** Canonical hash of the world at the end: equal hashes mean the same run. */
  hash: string;
  /** Tick of the attacker's first action, or 0. */
  firstActionTick: number;
  /** Tick of the first IDS alert, or 0 when nothing was noticed. */
  detectedAt: number;
  alerts: number;
  /** Operations that ended at a boundary that closed in front of them. */
  blocked: number;
  /** Tick of the first such block, or 0. */
  firstBlockedTick: number;
  /** Launches the engine refused, mostly for want of a permitted path. */
  refused: number;
  /** Nodes that hold an intruder foothold at the end, in id order. */
  compromised: string[];
  /** Nodes whose command channel is blocked at the end, in id order. */
  commandChannelLost: string[];
}

/** Steps `initial` through `actions` up to and including `toTick` and sums the run up. */
export function runOutcome(
  initial: World,
  index: Index,
  actions: readonly TimedAction[],
  toTick: number,
): Outcome {
  const byTick = new Map<number, TimedAction["a"][]>();
  for (const { t, a } of actions) {
    const bucket = byTick.get(t);
    if (bucket) bucket.push(a);
    else byTick.set(t, [a]);
  }
  let world = initial;
  let alerts = 0;
  let blocked = 0;
  let firstBlockedTick = 0;
  let refused = 0;
  while (world.tick < toTick) {
    const result = step(world, byTick.get(world.tick + 1) ?? [], index);
    world = result.world;
    for (const event of result.events) {
      if (event.k === "ids.alert") alerts++;
      else if (event.k === "technique.rejected") refused++;
      else if (event.k === "op.blocked") {
        blocked++;
        if (firstBlockedTick === 0) firstBlockedTick = event.tick;
      }
    }
  }
  return {
    hash: stateHash(world),
    firstActionTick: world.firstActionTick,
    detectedAt: world.detectedAt,
    alerts,
    blocked,
    firstBlockedTick,
    refused,
    compromised: world.nodes.filter((n) => n.integrity > 0).map((n) => n.id),
    commandChannelLost: world.nodes.filter((n) => n.cmdBlocked).map((n) => n.id),
  };
}

export interface Comparison {
  /** The session as recorded. */
  undefended: Outcome;
  /** The same session from the same world with `extra` added to it. */
  defended: Outcome;
}

/**
 * Runs the same session twice from the same world, and so the same seed: once as it is,
 * once with extra actions (a defense, say) inserted at their own ticks. Both runs are
 * deterministic, so the difference between them is the extra actions and nothing else.
 */
export function counterfactual(
  initial: World,
  index: Index,
  actions: readonly TimedAction[],
  toTick: number,
  extra: readonly TimedAction[],
): Comparison {
  return {
    undefended: runOutcome(initial, index, actions, toTick),
    // The recorded actions first, so on a shared tick they keep their order.
    defended: runOutcome(initial, index, [...actions, ...extra], toTick),
  };
}
