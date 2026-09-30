import { PERMILLE } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { Availability, NodeState, ViewState, World } from "../sim/world";
import type { Effect, EffectKind } from "./types";

/**
 * The only place an attack touches the world, and it touches nothing but the
 * cyber fields of a NodeState (integrity, discovered, cmdBlocked, controlDenied,
 * controlRecoverAt, view, availability, paramClampPermille). Every write is
 * monotone: a foothold never shrinks, a flag only turns on (and a temporary denial
 * only ever lasts longer), a view or an availability only gets worse and a
 * parameter cap only goes down. The way back is never the attacker's: it is the
 * lifecycle below, a timer that lifts a temporary denial and the local restoration.
 * The railway learns of these fields solely through
 * deriveRailInputs, which can only restrict, so there is no path from here to a
 * lock, an aspect, a point or a train. Keep it that way: adding a member to
 * Effect that needs anything else is a design decision, not a code change.
 *
 * Returns true when the world changed.
 */
export function applyEffect(world: World, index: Index, targetId: string, effect: Effect): boolean {
  const target = world.nodes.find((n) => n.id === targetId);
  if (target === undefined) return false;

  switch (effect.k) {
    case "foothold": {
      if (target.integrity >= effect.priv) return false;
      target.integrity = effect.priv;
      return true;
    }
    case "discover":
      return discover(world, index, target, effect.hops);
    case "blockCommands": {
      if (!hasTag(index, target, effect.onTag) || target.cmdBlocked) return false;
      target.cmdBlocked = true;
      return true;
    }
    case "denyControl": {
      if (!hasTag(index, target, effect.onTag)) return false;
      // 0 means the denial has no end of its own.
      const until = effect.recoverTicks === undefined ? 0 : world.tick + effect.recoverTicks;
      if (!target.controlDenied) {
        target.controlDenied = true;
        target.controlRecoverAt = until;
        return true;
      }
      // Already denied: a second hit can only make it last longer, never shorter.
      if (target.controlRecoverAt === 0) return false;
      if (until !== 0 && until <= target.controlRecoverAt) return false;
      target.controlRecoverAt = until;
      return true;
    }
    case "setView": {
      if (VIEW_RANK[effect.state] <= VIEW_RANK[target.view]) return false;
      target.view = effect.state;
      return true;
    }
    case "degrade": {
      if (AVAILABILITY_RANK[effect.state] <= AVAILABILITY_RANK[target.availability]) return false;
      target.availability = effect.state;
      return true;
    }
    case "clampParam": {
      if (effect.permille >= target.paramClampPermille) return false;
      target.paramClampPermille = effect.permille;
      return true;
    }
    default:
      return assertNever(effect);
  }
}

/**
 * The lifecycle of a temporary effect: lifts every denial of control whose time is
 * up. Keyed by tick number, never by wall-clock time, so the same tick clears it
 * however the ticks are batched. Only this timer and restoreNode can turn a cyber
 * field back; nothing here touches the railway.
 */
export function expireEffects(world: World, tick: number, events: SimEvent[]): void {
  for (const node of world.nodes) {
    if (node.controlDenied && node.controlRecoverAt !== 0 && node.controlRecoverAt <= tick) {
      node.controlDenied = false;
      node.controlRecoverAt = 0;
      events.push({ k: "effect.cleared", tick, node: node.id, effect: "denyControl" });
    }
  }
}

/**
 * Local restoration at a node, the answer to the restore action: the operators'
 * picture, the node's availability, its command channel, its controls and its
 * parameter cap all go back to normal. What the attacker learned (foothold,
 * discovery) stays: restoring a system does not evict an intruder. It returns
 * the cyber fields to the state of an undisturbed railway, which is the state the
 * safety case already covers, and it is only ever reached through an action, never
 * through an effect. Returns true when anything changed.
 */
export function restoreNode(
  world: World,
  nodeId: string,
  tick: number,
  events: SimEvent[],
): boolean {
  const node = world.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return false;
  let changed = false;
  const cleared = (effect: EffectKind): void => {
    changed = true;
    events.push({ k: "effect.cleared", tick, node: node.id, effect });
  };
  if (node.view !== "ok") {
    node.view = "ok";
    cleared("setView");
  }
  if (node.availability !== "ok") {
    node.availability = "ok";
    cleared("degrade");
  }
  if (node.cmdBlocked) {
    node.cmdBlocked = false;
    cleared("blockCommands");
  }
  if (node.controlDenied) {
    node.controlDenied = false;
    node.controlRecoverAt = 0;
    cleared("denyControl");
  }
  if (node.paramClampPermille < PERMILLE) {
    node.paramClampPermille = PERMILLE;
    cleared("clampParam");
  }
  return changed;
}

/** Worse views rank higher; a write that would not rank higher is ignored. */
const VIEW_RANK: Record<ViewState, number> = { ok: 0, spoofed: 1, frozen: 2, blank: 3 };

const AVAILABILITY_RANK: Record<Availability, number> = { ok: 0, degraded: 1, down: 2 };

function assertNever(value: never): never {
  throw new Error(`applyEffect: unhandled effect ${JSON.stringify(value)}`);
}

function hasTag(index: Index, node: NodeState, tag: string | undefined): boolean {
  if (tag === undefined) return true;
  return index.nodeDefs.get(node.id)?.tags.includes(tag) ?? false;
}

/** Marks every node within `hops` links of `from` as known to the attacker. */
function discover(world: World, index: Index, from: NodeState, hops: number): boolean {
  const byId = new Map<string, NodeState>();
  for (const node of world.nodes) byId.set(node.id, node);

  const depth = new Map<string, number>([[from.id, 0]]);
  const queue = [from.id];
  let changed = false;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (at === undefined) continue;
    const state = byId.get(at);
    if (state !== undefined && !state.discovered) {
      state.discovered = true;
      changed = true;
    }
    const d = depth.get(at) ?? 0;
    if (d >= hops) continue;
    for (const { node } of index.net.adjacency.get(at) ?? []) {
      if (depth.has(node)) continue;
      depth.set(node, d + 1);
      queue.push(node);
    }
  }
  return changed;
}
