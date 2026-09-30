import { restoreNode } from "../attack/effects";
import { launchTechnique } from "../attack/ops";
import { isPlaybookSteps } from "../attack/playbook";
import type { PlaybookStep } from "../attack/types";
import {
  type DefenseConfig,
  type DefenseKind,
  type DefenseTarget,
  isDefenseConfig,
  isDefenseKind,
  isDefenseTarget,
  placeDefense,
  removeDefense,
} from "../net/defenses";
import { enqueueRequest } from "../rail/interlocking";
import { DEFENSE_PLACEMENT_LATENCY_TICKS, MAX_PLAYBOOKS } from "./constants";
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
  | { type: "route.cancel"; route: string }
  /**
   * Local restoration at a node: the operators fix it on site. Clears what an attack
   * did to the node (view, availability, command channel, controls, speed cap) and
   * never the attacker's foothold. It has nothing to do with routes, signals or trains.
   */
  | { type: "restore"; node: string }
  /**
   * Put a firewall, a data diode or an IDS sensor on a conduit or a link. The only way a
   * user changes the network. It narrows traffic and raises detection, nothing more.
   */
  | { type: "defense.place"; kind: DefenseKind; on: DefenseTarget; config?: DefenseConfig }
  /** Take a placed defense away, by the id the placement was given. */
  | { type: "defense.remove"; id: string }
  /**
   * Run resolved steps in order, each launching when the operation before it has ended.
   * Steps name a technique and at most a node, role or zone of the content: what a mapper
   * produces after validation, never free text.
   */
  | { type: "playbook.start"; steps: PlaybookStep[] };

/** The keys each action type may carry, and no others. */
const ACTION_KEYS = new Map<string, readonly string[]>([
  ["noop", ["type"]],
  ["technique.launch", ["type", "technique", "target"]],
  ["route.request", ["type", "route"]],
  ["route.cancel", ["type", "route"]],
  ["restore", ["type", "node"]],
  ["defense.place", ["type", "kind", "on", "config"]],
  ["defense.remove", ["type", "id"]],
  ["playbook.start", ["type", "steps"]],
]);

/**
 * Runtime guard for untrusted input such as a parsed recording. Extend with the
 * union. The shape is exact: a known type with any key beyond its own is refused,
 * so a hostile recorded action cannot carry extra fields into the engine.
 */
export function isAction(value: unknown): value is Action {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = typeof v.type === "string" ? ACTION_KEYS.get(v.type) : undefined;
  if (allowed === undefined || !Object.keys(v).every((key) => allowed.includes(key))) return false;
  switch (v.type) {
    case "noop":
      return true;
    case "technique.launch":
      return typeof v.technique === "string" && typeof v.target === "string";
    case "route.request":
    case "route.cancel":
      return typeof v.route === "string";
    case "restore":
      return typeof v.node === "string";
    case "defense.place":
      return (
        isDefenseKind(v.kind) &&
        isDefenseTarget(v.on) &&
        (v.config === undefined || isDefenseConfig(v.config))
      );
    case "defense.remove":
      return typeof v.id === "string";
    case "playbook.start":
      return isPlaybookSteps(v.steps);
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
    case "restore": {
      if (!world.nodes.some((n) => n.id === action.node)) {
        events.push({ k: "action.rejected", tick, reason: "unknown-node" });
        return;
      }
      restoreNode(world, action.node, tick, events);
      return;
    }
    case "defense.place": {
      if (index === undefined) {
        events.push({ k: "action.rejected", tick, reason: "no-index" });
        return;
      }
      placeDefense(world, index, action, tick, DEFENSE_PLACEMENT_LATENCY_TICKS, events);
      return;
    }
    case "defense.remove":
      removeDefense(world, action.id, tick, events);
      return;
    case "playbook.start": {
      if (index === undefined) {
        events.push({ k: "action.rejected", tick, reason: "no-index" });
        return;
      }
      if (world.playbooks.length >= MAX_PLAYBOOKS) {
        events.push({ k: "action.rejected", tick, reason: "playbook-limit" });
        return;
      }
      const steps = action.steps.map((s) =>
        s.target === undefined
          ? { technique: s.technique }
          : { technique: s.technique, target: { ...s.target } },
      );
      world.playbooks.push({ steps, next: 0, waitOp: -1, readyAt: tick });
      return;
    }
  }
}
