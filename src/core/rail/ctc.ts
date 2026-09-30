import { APPROACH_DM, CTC_RETRY_TICKS, TRAIN_LENGTH_DM } from "../sim/constants";
import type { SimEvent } from "../sim/events";
import type { Index } from "../sim/model";
import { compareId, type World } from "../sim/world";
import { enqueueRequest } from "./interlocking";
import { conflictsWith, overlapReleased } from "./routes";
import { computeOccupancy, FREE, type ServiceGeometry } from "./trackGraph";

/**
 * Whether a departure may enter the model now. The first section and the first
 * route (with its overlap) must be clear, and no held route may already claim
 * the section the train would appear in. Without the last test two trains could
 * be sent towards each other along a single-track branch.
 */
function canSpawn(world: World, index: Index, geometry: ServiceGeometry, occ: Uint8Array): boolean {
  const { routes } = index.rail;
  const first = geometry.pathSections[0];
  if (first === undefined || occ[first] !== FREE) return false;

  for (const il of world.interlockings) {
    for (const lock of il.locks) {
      const held = routes.byId.get(lock.route);
      if (!held) continue;
      if (held.blockSections.includes(first) || held.overlapSections.includes(first)) return false;
    }
  }

  const routeId = geometry.sigs[0]?.routeId;
  const route = routeId === undefined ? undefined : routes.byId.get(routeId);
  if (route !== undefined) {
    for (const s of [...route.blockSections, ...route.overlapSections]) {
      if (occ[s] !== FREE) return false;
    }
    for (const il of world.interlockings) {
      for (const lock of il.locks) {
        const held = routes.byId.get(lock.route);
        if (held && conflictsWith(held, route, overlapReleased(world, index.rail, held))) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Releases departures from the fixed timetable. A departure whose slot has
 * passed waits until the network can take it; the slots after it stay put.
 */
export function stepTimetable(world: World, index: Index, events: SimEvent[]): void {
  const { graph } = index.rail;
  let spawned = false;
  let occ = computeOccupancy(world, graph);
  for (const service of world.services) {
    const geometry = graph.services.get(service.id);
    if (geometry === undefined || service.released >= geometry.def.count) continue;
    const due = geometry.def.firstTick + service.released * geometry.def.headwayTicks;
    if (world.tick < due || !canSpawn(world, index, geometry, occ)) continue;

    service.released += 1;
    const id = `${service.id}#${service.released}`;
    world.trains.push({
      id,
      service: service.id,
      posDm: TRAIN_LENGTH_DM,
      speedDmPerTick: 0,
      sig: 0,
      stop: 0,
      dwell: 0,
      overrun: -1,
      lastReq: -CTC_RETRY_TICKS,
    });
    events.push({ k: "train.spawned", tick: world.tick, train: id, service: service.id });
    spawned = true;
    occ = computeOccupancy(world, graph);
  }
  if (spawned) world.trains.sort(compareId);
}

/**
 * The dispatch layer. When a train comes within approach distance of its next
 * signal it asks the interlocking for the route its service takes from there.
 * This is the command channel an attacker can starve: the interlocking stays
 * the authority and simply never receives the request, so the train waits at
 * the signal.
 */
export function stepCtc(world: World, index: Index, events: SimEvent[]): void {
  const { graph, routes } = index.rail;
  for (const train of world.trains) {
    if (train.overrun >= 0) continue;
    const ahead = graph.services.get(train.service)?.sigs[train.sig];
    if (ahead === undefined || ahead.routeId === undefined) continue;
    if (ahead.posDm - train.posDm > APPROACH_DM) continue;
    if (world.tick - train.lastReq < CTC_RETRY_TICKS) continue;

    const route = routes.byId.get(ahead.routeId);
    const il = route === undefined ? undefined : world.interlockings.find((i) => i.id === route.il);
    if (route === undefined || il === undefined) continue;
    if (il.locks.some((l) => l.route === route.def.id)) continue;
    if (il.queue.some((q) => q.route === route.def.id && q.kind === "set")) continue;

    enqueueRequest(world, index, route.def.id, "set", "ctc", events);
    train.lastReq = world.tick;
  }
}
