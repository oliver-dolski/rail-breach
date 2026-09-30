import type { SignalDef } from "../../content/types";
import { APPROACH_LOCK_DM } from "../sim/constants";
import type { Aspect, SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import type { InterlockingState, RequestSource, RouteRequest, World } from "../sim/world";
import { deriveRailInputs, type RailInputs } from "./inputs";
import { proveRoute, type RouteInfo, routeStillProved } from "./routes";
import { computeOccupancy, FREE, OCCUPIED } from "./trackGraph";

export type { Aspect };

/** Stop and dark are both "do not pass". Everything not clearly permissive is one of them. */
export function isRestrictive(aspect: Aspect): boolean {
  return aspect === "stop" || aspect === "dark";
}

function interlockingOf(world: World, id: string): InterlockingState | undefined {
  return world.interlockings.find((i) => i.id === id);
}

/**
 * True when this interlocking holds a route entered at `signalId` that it can
 * still offer: a route no train has entered yet is withdrawn from the signal
 * while the command channel is lost (see deriveAspect).
 */
function holdsRouteAt(index: Index, il: InterlockingState, signalId: string): boolean {
  if (il.cmdBlocked) return false;
  return il.locks.some((l) => index.rail.routes.byId.get(l.route)?.entry.id === signalId);
}

/**
 * The aspect a signal shows. Derived from scratch on every call and never
 * stored, so there is no stale "proceed" for an attack to leave behind.
 *
 *  dark    the interlocking is down or the lamp's controller failed
 *  stop    no locked route, the route is in use, it is no longer proved, or the
 *          command channel is lost and no train has entered the route yet
 *  caution the route is proved but the next signal is at stop
 *  proceed the route is proved and the next signal also has a route
 */
export function deriveAspect(
  signal: SignalDef,
  world: World,
  index: Index,
  occ: Uint8Array = computeOccupancy(world, index.rail.graph),
): Aspect {
  const il = interlockingOf(world, signal.interlocking);
  if (!il || il.health === "down") return "dark";
  if (world.darkSignals.includes(signal.id)) return "dark";

  const { routes } = index.rail;
  const lock = il.locks.find((l) => routes.byId.get(l.route)?.entry.id === signal.id);
  if (!lock || lock.used) return "stop";
  // Loss of the command channel is a fail-safe condition: a route that is set
  // but not yet entered no longer shows a proceed aspect. The lock stays as it
  // is (approach locking still applies) and so does any route a train is
  // already running through, because that train is past its signal.
  if (il.cmdBlocked) return "stop";
  const route = routes.byId.get(lock.route);
  if (!route || !routeStillProved(world, route, occ)) return "stop";

  const end = route.endSignal;
  if (end === undefined) return "proceed";
  const endIl = interlockingOf(world, end.interlocking);
  const endHasRoute =
    endIl !== undefined && endIl.health === "ok" && holdsRouteAt(index, endIl, end.id);
  return endHasRoute ? "proceed" : "caution";
}

/** Aspects of every signal, in the order of index.rail.graph.signals. */
export function deriveAspects(world: World, index: Index): Aspect[] {
  const occ = computeOccupancy(world, index.rail.graph);
  return index.rail.graph.signals.map((s) => deriveAspect(s, world, index, occ));
}

/** Puts a request into its interlocking's queue. An unknown route is refused on the spot. */
export function enqueueRequest(
  world: World,
  index: Index,
  routeId: string,
  kind: RouteRequest["kind"],
  by: RequestSource,
  events: SimEvent[],
): void {
  const route = index.rail.routes.byId.get(routeId);
  const il = route === undefined ? undefined : interlockingOf(world, route.il);
  if (route === undefined || il === undefined) {
    events.push({
      k: "command.rejected",
      tick: world.tick,
      il: "",
      route: routeId,
      by,
      reason: "unknown route",
    });
    return;
  }
  il.queue.push({ route: routeId, kind, by, tick: world.tick });
}

/** Whether a train is close enough to the route's entry signal that it could not stop for it. */
function approachLocked(world: World, index: Index, route: RouteInfo): boolean {
  for (const train of world.trains) {
    const geometry = index.rail.graph.services.get(train.service);
    const next = geometry?.sigs[train.sig];
    if (next === undefined || next.signal.id !== route.entry.id) continue;
    const distance = next.posDm - train.posDm;
    if (distance >= 0 && distance <= APPROACH_LOCK_DM) return true;
  }
  return false;
}

function compareRequests(a: RouteRequest, b: RouteRequest): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.route !== b.route) return a.route < b.route ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return 0;
}

/** Applies one request. Returns why it was refused, or undefined when it succeeded. */
function applyRequest(
  world: World,
  index: Index,
  il: InterlockingState,
  req: RouteRequest,
  occ: Uint8Array,
  events: SimEvent[],
): string | undefined {
  const { graph, routes } = index.rail;
  const tick = world.tick;
  const route = routes.byId.get(req.route);
  if (!route) return "unknown route";
  if (il.health === "down") return "interlocking is out of service";
  if (il.cmdBlocked) return "command channel is blocked";

  if (req.kind === "cancel") {
    const lock = il.locks.find((l) => l.route === req.route);
    if (!lock) return "route is not set";
    if (lock.used) return "route is in use by a train";
    if (approachLocked(world, index, route)) {
      return "approach locked: a train is within braking distance of the signal";
    }
    il.locks = il.locks.filter((l) => l.route !== req.route);
    events.push({ k: "route.released", tick, il: il.id, route: req.route, cause: "cancelled" });
    return undefined;
  }

  const proof = proveRoute(world, index.rail, route, occ);
  if (!proof.ok) return proof.reason;

  il.locks.push({ route: req.route, used: false });
  il.locks.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  for (const want of route.def.points) {
    const point = world.points.find((p) => p.id === want.point);
    const def = graph.points.get(want.point);
    if (!point || !def) continue;
    const settled = point.pos === want.pos && point.moving === 0;
    const underway = point.target === want.pos && point.moving > 0;
    if (settled || underway) continue;
    point.target = want.pos;
    point.moving = def.movingTicks;
  }
  events.push({ k: "route.set", tick, il: il.id, route: req.route, by: req.by });
  return undefined;
}

/**
 * Advances every interlocking by one tick, in id order. The interlocking is the
 * safety authority: the cyber side and the dispatch layer only ever make
 * requests, and the only thing the cyber side can change is `inputs`, which can
 * only restrict.
 *
 * Down: all signals derive dark, existing locks are held, points are frozen
 * and no request succeeds.
 */
export function stepInterlocking(
  world: World,
  index: Index,
  events: SimEvent[],
  inputs: RailInputs = deriveRailInputs(world, index),
): void {
  const { graph, routes } = index.rail;
  const tick = world.tick;

  for (const il of world.interlockings) {
    const health = inputs.interlockingHealth[il.id] ?? "ok";
    if (health !== il.health) events.push({ k: "interlocking.health", tick, il: il.id, health });
    il.health = health;
    il.cmdBlocked = inputs.cmdBlocked[il.id] ?? false;
  }
  world.disturbed = [...inputs.disturbedSections];
  world.darkSignals = [...inputs.darkSignals];

  for (const point of world.points) {
    const owner = interlockingOf(world, graph.points.get(point.id)?.interlocking ?? "");
    if (point.moving > 0 && owner?.health === "ok") {
      point.moving -= 1;
      if (point.moving === 0) point.pos = point.target;
    }
  }

  const occ = computeOccupancy(world, graph);
  for (const il of world.interlockings) {
    const kept = [];
    for (const lock of il.locks) {
      const route = routes.byId.get(lock.route);
      if (!route) continue;
      if (!lock.used && route.blockSections.some((s) => occ[s] === OCCUPIED)) lock.used = true;
      const clear = route.blockSections.every((s) => occ[s] === FREE);
      if (lock.used && clear && il.health === "ok") {
        events.push({ k: "route.released", tick, il: il.id, route: lock.route, cause: "cleared" });
        continue;
      }
      kept.push(lock);
    }
    il.locks = kept;
  }

  for (const il of world.interlockings) {
    if (il.queue.length === 0) continue;
    const pending = [...il.queue].sort(compareRequests);
    il.queue = [];
    for (const req of pending) {
      const reason = applyRequest(world, index, il, req, occ, events);
      if (reason !== undefined) {
        events.push({
          k: "command.rejected",
          tick,
          il: il.id,
          route: req.route,
          by: req.by,
          reason,
        });
      }
    }
  }
}
