import type { Index } from "../sim/model";
import type { World } from "../sim/world";

/**
 * The only bridge from the cyber graph to the track. Every field can only make
 * the railway more restrictive: an interlocking can go down, a command channel
 * can close, a section can be reported disturbed, a lamp can go out. Nothing
 * here can grant a proceed aspect, clear a lock or move a train, and there is
 * deliberately no field that could be extended to do so.
 */
export interface RailInputs {
  interlockingHealth: Record<string, "ok" | "down">;
  cmdBlocked: Record<string, boolean>;
  /** Sections the interlocking must treat as occupied. Sorted, unique. */
  disturbedSections: string[];
  /** Signals forced dark. Sorted, unique. */
  darkSignals: string[];
  /**
   * Reserved for restrictive parameter changes (a lower speed cap and similar).
   * Always empty until the attack catalogue in a later phase writes to it.
   */
  paramClamps: Record<string, number>;
}

/** The inputs of an undisturbed railway. */
export function neutralInputs(world: World): RailInputs {
  const interlockingHealth: Record<string, "ok" | "down"> = {};
  const cmdBlocked: Record<string, boolean> = {};
  for (const il of world.interlockings) {
    interlockingHealth[il.id] = "ok";
    cmdBlocked[il.id] = false;
  }
  return {
    interlockingHealth,
    cmdBlocked,
    disturbedSections: [],
    darkSignals: [],
    paramClamps: {},
  };
}

function sortedUnique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/**
 * Reads the cyber state of every node and maps it to restrictive rail inputs.
 *
 *  - an interlocking node that is down takes its interlocking out of service
 *  - a closed command channel (on the front-end processor or the traffic
 *    management server: every interlocking; on an interlocking: that one)
 *  - an object controller that is degraded or shows spoofed data leaves its
 *    axle-counter sections disturbed, which the interlocking treats as occupied
 *  - an object controller that is down also darkens the signals it drives
 *
 * With no cyber effects present the result equals neutralInputs.
 */
export function deriveRailInputs(world: World, index: Index): RailInputs {
  const inputs = neutralInputs(world);
  const { graph } = index.rail;
  const disturbed: string[] = [];
  const dark: string[] = [];

  for (const node of world.nodes) {
    const isCentralChannel = node.kind === "front-end-processor" || node.kind === "scada-server";
    if (node.cmdBlocked) {
      if (isCentralChannel) {
        for (const id of Object.keys(inputs.cmdBlocked)) inputs.cmdBlocked[id] = true;
      } else if (node.controls !== "" && inputs.cmdBlocked[node.controls] !== undefined) {
        inputs.cmdBlocked[node.controls] = true;
      }
    }
    if (node.kind === "interlocking" && node.controls !== "" && node.availability === "down") {
      if (inputs.interlockingHealth[node.controls] !== undefined) {
        inputs.interlockingHealth[node.controls] = "down";
      }
    }
    if (node.kind === "object-controller") {
      const unreliable =
        node.availability === "degraded" || node.availability === "down" || node.view === "spoofed";
      if (unreliable) {
        for (const block of graph.blocks.values()) {
          if (block.controller === node.id) disturbed.push(block.section);
        }
      }
      if (node.availability === "down") {
        for (const signal of graph.signals) {
          if (signal.controller === node.id) dark.push(signal.id);
        }
      }
    }
  }
  inputs.disturbedSections = sortedUnique(disturbed);
  inputs.darkSignals = sortedUnique(dark);
  return inputs;
}
