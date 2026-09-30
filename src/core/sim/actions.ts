import { launchTechnique } from "../attack/ops";
import { enqueueRequest } from "../rail/interlocking";
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
      if (!world.nodes.some((n) => n.id === action.target)) {
        events.push({ k: "action.rejected", tick, reason: "unknown-node" });
        return;
      }
      if (index === undefined) {
        events.push({ k: "action.rejected", tick, reason: "no-index" });
        return;
      }
      launchTechnique(world, action, tick, events, index);
      return;
    }
  }
}
