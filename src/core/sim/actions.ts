import { chance } from "../rng";
import { PURPOSE_TECHNIQUE_SUCCESS } from "./constants";
import type { SimEvent } from "./events";
import type { World } from "./world";

/**
 * Inputs to the simulation. The union grows in later plans; every member must
 * stay plain JSON because actions are what a recording persists.
 */
export type Action =
  | { type: "noop" }
  | { type: "technique.launch"; technique: string; target: string };

/** Placeholder success chance until the rule engine derives it from content. */
const PLACEHOLDER_SUCCESS_PERMILLE = 700;

/**
 * Applies one action to a world that step() has already cloned. `tick` is the
 * tick this step produces; it stamps events and keys the dice.
 */
export function applyAction(world: World, action: Action, tick: number, events: SimEvent[]): void {
  switch (action.type) {
    case "noop":
      return;
    case "technique.launch": {
      const node = world.nodes.find((n) => n.id === action.target);
      if (node === undefined) {
        events.push({ k: "action.rejected", tick, reason: "unknown-node" });
        return;
      }
      const ok = chance(
        PLACEHOLDER_SUCCESS_PERMILLE,
        world.seed,
        tick,
        node.key,
        PURPOSE_TECHNIQUE_SUCCESS,
      );
      if (ok) {
        if (node.integrity < 1) node.integrity = 1;
        events.push({ k: "technique.succeeded", tick, technique: action.technique, node: node.id });
      } else {
        events.push({ k: "technique.failed", tick, technique: action.technique, node: node.id });
      }
      return;
    }
  }
}
