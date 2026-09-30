import type { LinkDef, NodeDef, Protocol } from "../../content/types";
import { linkAllows } from "../net/defenses";
import { findPath, type NetPath } from "../net/graph";
import { chance, roll32 } from "../rng";
import { PERMILLE, PURPOSE_OP_DURATION, PURPOSE_TECHNIQUE_SUCCESS } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { World } from "../sim/world";
import { applyEffect, expireEffects } from "./effects";
import type { NodeSelector, Op, Precondition, TechniqueDef } from "./types";

/**
 * Whether traffic of `protocol` may cross `link` from `from` to `to` right now. Every
 * reachability decision goes through here, both when a path is planned and again at
 * every hop: the link must carry the protocol and every defense in force on it must
 * agree (see linkAllows). Null means the technique does not travel.
 */
export function linkPermits(
  link: LinkDef,
  protocol: Protocol | null,
  from: string,
  to: string,
  world: World,
  tick: number,
): boolean {
  return linkAllows(link, protocol, from, to, world, tick);
}

/** Whether a technique's target selector admits this node. Every given field must match. */
export function selectorMatches(
  selector: NodeSelector,
  def: Pick<NodeDef, "kind" | "roles" | "tags">,
): boolean {
  if (selector.kinds !== undefined && !selector.kinds.includes(def.kind)) return false;
  if (selector.roles !== undefined && !selector.roles.some((r) => def.roles.includes(r))) {
    return false;
  }
  if (selector.tags !== undefined && !selector.tags.some((t) => def.tags.includes(t))) {
    return false;
  }
  return true;
}

/** The shortest permitted path from any of `starts` (in id order) to `target`. */
function bestPath(
  world: World,
  index: Index,
  starts: readonly string[],
  target: string,
  protocol: Protocol,
): NetPath | null {
  let best: NetPath | null = null;
  for (const start of starts) {
    const path = findPath(index.net, start, target, (link, from, to) =>
      linkPermits(link, protocol, from, to, world, world.tick),
    );
    if (path !== null && (best === null || path.links.length < best.links.length)) best = path;
  }
  return best;
}

interface Evaluation {
  reasons: string[];
  path: NetPath | null;
}

/** Checks every precondition and collects each failure, so a refusal is explained whole. */
export function evaluate(
  world: World,
  index: Index,
  def: TechniqueDef,
  target: string,
): Evaluation {
  const reasons: string[] = [];
  let path: NetPath | null = null;
  const state = world.nodes.find((n) => n.id === target);

  for (const pre of def.pre as readonly Precondition[]) {
    switch (pre.k) {
      case "reach": {
        const starts = world.nodes
          .filter((n) => (pre.from === "external" ? n.kind === "external" : n.integrity >= 1))
          .map((n) => n.id);
        const origin = pre.from === "external" ? "the outside" : "a compromised node";
        path = starts.length === 0 ? null : bestPath(world, index, starts, target, pre.protocol);
        if (path === null)
          reasons.push(`no permitted ${pre.protocol} path from ${origin} to ${target}`);
        break;
      }
      case "targetFoothold":
        if ((state?.integrity ?? 0) < pre.min) reasons.push(`no foothold on ${target}`);
        break;
      case "targetDiscovered":
        if (state?.discovered !== true) reasons.push(`${target} has not been discovered`);
        break;
    }
  }
  return { reasons, path };
}

/**
 * Turns a technique.launch action into a running operation, or a
 * technique.rejected event that names what was missing. Targets arrive already
 * resolved to a node id: recordings never hold free text.
 */
export function launchTechnique(
  world: World,
  action: { technique: string; target: string },
  tick: number,
  events: SimEvent[],
  index: Index,
): void {
  const { technique, target } = action;
  const reject = (...reasons: string[]): void => {
    events.push({ k: "technique.rejected", tick, technique, target, reasons });
  };

  const def = index.techniques.get(technique);
  if (def === undefined) {
    reject("unknown technique");
    return;
  }
  const nodeDef = index.nodeDefs.get(target);
  if (nodeDef === undefined) {
    reject(`unknown node ${target}`);
    return;
  }
  if (!selectorMatches(def.targets, nodeDef)) {
    reject(`${target} is not a valid target for ${def.id}`);
    return;
  }

  const { reasons, path } = evaluate(world, index, def, target);
  if (reasons.length > 0) {
    reject(...reasons);
    return;
  }

  const route = path ?? { nodes: [target], links: [] };
  const op: Op = {
    id: world.opSeq,
    technique: def.id,
    target,
    path: route.nodes,
    links: route.links,
    hop: 0,
    doneAt: tick,
  };
  world.opSeq += 1;
  events.push({
    k: "op.started",
    tick,
    op: op.id,
    technique: def.id,
    target,
    from: route.nodes[0] ?? target,
  });
  if (depart(world, index, def, op, tick, events)) world.ops.push(op);
}

/** Integer share: floor(value * permille / 1000). */
const scale = (value: number, permille: number): number =>
  Math.floor((value * permille) / PERMILLE);

/** The success chance after the target's own resistance. Permille. */
function successChance(def: TechniqueDef, nodeDef: NodeDef | undefined): number {
  let p = def.successPermille;
  if (def.resistance !== "none") p = scale(p, PERMILLE - (nodeDef?.hardeningPermille ?? 0));
  if (def.resistance === "host-and-user")
    p = scale(p, PERMILLE - (nodeDef?.awarenessPermille ?? 0));
  return p;
}

/**
 * Starts the next stage of an operation at `tick`: a hop along the next link,
 * or the work on the target once the last node is reached. Returns false when
 * the link is no longer permitted, in which case the operation ends here.
 */
function depart(
  world: World,
  index: Index,
  def: TechniqueDef,
  op: Op,
  tick: number,
  events: SimEvent[],
): boolean {
  if (op.hop >= op.path.length - 1) {
    const [min, max] = def.durationTicks;
    const span = max - min + 1;
    const jitter = roll32(world.seed, tick, op.id, PURPOSE_OP_DURATION) % span;
    op.doneAt = tick + Math.max(1, min + jitter);
    return true;
  }
  const linkId = op.links[op.hop];
  const link = linkId === undefined ? undefined : index.net.linkById.get(linkId);
  const from = op.path[op.hop];
  const to = op.path[op.hop + 1];
  if (link === undefined || from === undefined || to === undefined) return false;
  if (!linkPermits(link, def.protocol, from, to, world, tick)) {
    events.push({ k: "op.blocked", tick, op: op.id, technique: def.id, link: link.id, at: from });
    return false;
  }
  op.doneAt = tick + Math.max(1, link.latencyTicks);
  events.push({
    k: "packet",
    tick,
    op: op.id,
    technique: def.id,
    link: link.id,
    from,
    to,
    arriveTick: op.doneAt,
  });
  return true;
}

/** Rolls the outcome of a finished operation and applies its effects. */
function finish(world: World, index: Index, def: TechniqueDef, op: Op, events: SimEvent[]): void {
  const tick = world.tick;
  const state = world.nodes.find((n) => n.id === op.target);
  if (state === undefined) return;
  const p = successChance(def, index.nodeDefs.get(op.target));
  const won = chance(p, world.seed, tick, state.key, PURPOSE_TECHNIQUE_SUCCESS, op.id);
  if (!won) {
    events.push({ k: "technique.failed", tick, op: op.id, technique: def.id, node: op.target });
    return;
  }
  events.push({ k: "technique.succeeded", tick, op: op.id, technique: def.id, node: op.target });
  for (const effect of def.effects) {
    if (applyEffect(world, index, op.target, effect)) {
      events.push({
        k: "effect.applied",
        tick,
        op: op.id,
        technique: def.id,
        node: op.target,
        effect: effect.k,
      });
    }
  }
}

/**
 * Advances every running operation by one tick, in launch order. A payload
 * that reaches the end of a link checks that the link still permits its
 * protocol before it goes on; one that finds the way shut ends there as an
 * op.blocked event. An operation that has reached its target rolls the outcome
 * once its work time is over. Temporary effects whose time is up end before any
 * operation moves.
 */
export function stepOps(world: World, index: Index, events: SimEvent[]): void {
  const tick = world.tick;
  // Temporary effects end first, so a denial that lands this tick is not lifted by it.
  expireEffects(world, tick, events);
  if (world.ops.length === 0) return;
  const kept: Op[] = [];
  for (const op of world.ops) {
    const def = index.techniques.get(op.technique);
    if (def === undefined) continue;
    if (op.doneAt > tick) {
      kept.push(op);
      continue;
    }
    if (op.hop >= op.path.length - 1) {
      finish(world, index, def, op, events);
      continue;
    }
    // The payload has crossed links[hop]: it must still have been allowed to.
    const crossed = index.net.linkById.get(op.links[op.hop] ?? "");
    const from = op.path[op.hop] ?? "";
    const to = op.path[op.hop + 1] ?? "";
    if (crossed === undefined || !linkPermits(crossed, def.protocol, from, to, world, tick)) {
      events.push({
        k: "op.blocked",
        tick,
        op: op.id,
        technique: def.id,
        link: crossed?.id ?? "",
        at: from,
      });
      continue;
    }
    op.hop += 1;
    if (depart(world, index, def, op, tick, events)) kept.push(op);
  }
  world.ops = kept;
}
