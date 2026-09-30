import {
  ACCEL_PERIOD_TICKS,
  EMERGENCY_BRAKE_PERIOD_TICKS,
  OVERRUN_RECOVERY_TICKS,
  SERVICE_BRAKE_PERIOD_TICKS,
  STOP_MARGIN_DM,
  STOP_TOLERANCE_DM,
  TERMINUS_DWELL_TICKS,
} from "../sim/constants";
import type { SimEvent, StopCause } from "../sim/events";
import type { Index } from "../sim/model";
import type { TrainState, World } from "../sim/world";
import { deriveAspect, isRestrictive } from "./interlocking";
import { stopDistance } from "./kinematics";
import { computeOccupancy, OCCUPIED, type ServiceGeometry } from "./trackGraph";

export { brakeDistance, emergencyBrakeDistance } from "./kinematics";

/** The nearest point the train must not go beyond, and why. */
interface Limit {
  posDm: number;
  cause: StopCause;
  signal?: string;
}

/**
 * Where the train has to stop, from the derived signal aspects: the first
 * signal ahead that is not clearly permissive, an occupied block ahead, the
 * next timetabled stop, or the end of the service path. A dark signal is
 * simply a signal that is not permissive, so it limits a train exactly like a
 * stop signal does.
 */
function findLimit(
  world: World,
  index: Index,
  train: TrainState,
  geometry: ServiceGeometry,
  occ: Uint8Array,
): Limit {
  let limit: Limit = { posDm: geometry.lengthDm, cause: "terminus" };

  const stop = geometry.stops[train.stop];
  if (stop !== undefined && stop.posDm < limit.posDm)
    limit = { posDm: stop.posDm, cause: "station" };

  for (let i = 0; i < geometry.blockStartDm.length; i++) {
    const start = geometry.blockStartDm[i] ?? 0;
    if (start < train.posDm) continue;
    if (start >= limit.posDm) break;
    const section = geometry.pathSections[i];
    if (section !== undefined && occ[section] === OCCUPIED) {
      limit = { posDm: start, cause: "signal" };
      break;
    }
  }

  for (let j = train.sig; j < geometry.sigs.length; j++) {
    const ps = geometry.sigs[j];
    if (ps === undefined || ps.posDm >= limit.posDm) break;
    if (isRestrictive(deriveAspect(ps.signal, world, index, occ))) {
      limit = { posDm: ps.posDm, cause: "signal", signal: ps.signal.id };
      break;
    }
  }
  return limit;
}

/**
 * Decides the speed for the next tick. Every branch keeps the train able to
 * stop short of the limit: it only holds or gains speed when the exact braking
 * distance from the resulting state still fits, brakes when it no longer does,
 * and uses the emergency rate when even service braking would overrun.
 */
function nextSpeed(v: number, room: number, k: number, vmax: number): number {
  const fitsAfter = (vn: number): boolean =>
    room - v >= stopDistance(vn, k + 1, SERVICE_BRAKE_PERIOD_TICKS);
  if (v < vmax && k % ACCEL_PERIOD_TICKS === 0 && fitsAfter(v + 1)) return v + 1;
  if (fitsAfter(v)) return v;
  if (room >= stopDistance(v, k, SERVICE_BRAKE_PERIOD_TICKS)) {
    return k % SERVICE_BRAKE_PERIOD_TICKS === 0 ? Math.max(0, v - 1) : v;
  }
  return k % EMERGENCY_BRAKE_PERIOD_TICKS === 0 ? Math.max(0, v - 1) : v;
}

/** Advances the train's signal pointer past every signal its front crossed this tick. */
function crossSignals(
  world: World,
  index: Index,
  train: TrainState,
  geometry: ServiceGeometry,
  occ: Uint8Array,
  events: SimEvent[],
): void {
  for (;;) {
    const ps = geometry.sigs[train.sig];
    if (ps === undefined || train.posDm <= ps.posDm) return;
    if (isRestrictive(deriveAspect(ps.signal, world, index, occ))) {
      train.overrun = train.sig;
      events.push({ k: "train.overran", tick: world.tick, train: train.id, signal: ps.signal.id });
    }
    train.sig += 1;
  }
}

/** Moves one train. Returns false when the train has finished and leaves the model. */
function moveTrain(
  world: World,
  index: Index,
  train: TrainState,
  geometry: ServiceGeometry,
  occ: Uint8Array,
  events: SimEvent[],
): boolean {
  const tick = world.tick;
  const vmax = index.rail.graph.vmaxDmPerTick;
  const v = train.speedDmPerTick;

  if (train.dwell > 0) {
    train.dwell -= 1;
    if (train.dwell === 0 && train.stop > geometry.stops.length) {
      events.push({ k: "train.arrived", tick, train: train.id });
      return false;
    }
    return true;
  }

  if (train.overrun >= 0) {
    // Ran past a signal at danger: emergency brake, the overlap is the margin.
    train.posDm += v;
    train.speedDmPerTick = decrementDue(tick, EMERGENCY_BRAKE_PERIOD_TICKS)
      ? Math.max(0, v - 1)
      : v;
    crossSignals(world, index, train, geometry, occ, events);
    if (train.speedDmPerTick === 0) {
      train.overrun = -1;
      train.dwell = OVERRUN_RECOVERY_TICKS;
      events.push({ k: "train.stopped", tick, train: train.id, cause: "overrun" });
    }
    return true;
  }

  if (v === 0) {
    const stop = geometry.stops[train.stop];
    if (stop !== undefined && stop.posDm - train.posDm <= STOP_TOLERANCE_DM) {
      train.stop += 1;
      train.dwell = stop.dwellTicks;
      return true;
    }
    if (
      train.stop === geometry.stops.length &&
      geometry.lengthDm - train.posDm <= STOP_TOLERANCE_DM
    ) {
      train.stop += 1;
      train.dwell = TERMINUS_DWELL_TICKS;
      return true;
    }
  }

  const limit = findLimit(world, index, train, geometry, occ);
  const room = limit.posDm - STOP_MARGIN_DM - train.posDm;
  const vNext = nextSpeed(v, room, tick, vmax);

  train.posDm += v;
  train.speedDmPerTick = vNext;
  if (v > 0 && vNext === 0) {
    const event: SimEvent = { k: "train.stopped", tick, train: train.id, cause: limit.cause };
    if (limit.signal !== undefined) event.signal = limit.signal;
    events.push(event);
  }
  crossSignals(world, index, train, geometry, occ, events);
  return true;
}

/** Speed steps down on every tick divisible by the brake period. */
function decrementDue(tick: number, period: number): boolean {
  return tick % period === 0;
}

/**
 * Advances every train one tick, in id order. Aspects and occupancy are read
 * from a snapshot taken before any train moves, so the result does not depend
 * on the order trains are visited in.
 */
export function stepTrains(world: World, index: Index, events: SimEvent[]): void {
  const { graph } = index.rail;
  const occ = computeOccupancy(world, graph);
  const kept: TrainState[] = [];
  for (const train of world.trains) {
    const geometry = graph.services.get(train.service);
    if (geometry === undefined || moveTrain(world, index, train, geometry, occ, events)) {
      kept.push(train);
    }
  }
  world.trains = kept;
}
