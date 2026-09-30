import { enqueueRequest } from "../rail/interlocking";
import { chance } from "../rng";
import { PURPOSE_TECHNIQUE_SUCCESS } from "./constants";
import type { SimEvent } from "./events";
import type { Index } from "./model";
import type { World } from "./world";

/**
 * Inputs to the simulation. The union grows in later plans; every member must
 * stay plain JSON because actions are what a recording persists.
 */
export type Action =
  | { type: "noop" }
  | { type: "technique.launch"; technique: string; target: string }
  /** Ask an interlocking to set a route. The interlocking may refuse. */
  | { type: "route.request"; route: string }
  /** Ask an interlocking to cancel a route it holds. Always a restrictive request. */
  | { type: "route.cancel"; route: string };

/** Runtime guard for untrusted input such as a parsed recording. Extend with the union. */
export function isAction(value: unknown): value is Action {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "noop":
      return true;
    case "technique.launch":
      return typeof v.technique === "string" && typeof v.target === "string";
    case "route.request":
    case "route.cancel":
      return typeof v.route === "string";
    default:
      return false;
  }
}

/** Placeholder success chance until the rule engine derives it from content. */
const PLACEHOLDER_SUCCESS_PERMILLE = 700;

/**
 * Applies one action to a world that step() has already cloned. `tick` is the
 * tick this step produces; it stamps events and keys the dice.
 */
export function applyAction(
  world: World,
  action: Action,
  tick: number,
  events: SimEvent[],
  index?: Index,
): void {
  switch (action.type) {
    case "noop":
      return;
    case "route.request":
    case "route.cancel": {
      if (index === undefined) return;
      const kind = action.type === "route.request" ? "set" : "cancel";
      enqueueRequest(world, index, action.route, kind, "operator", events);
      return;
    }
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
