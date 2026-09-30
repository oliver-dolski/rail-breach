import {
  EMERGENCY_BRAKE_PERIOD_TICKS,
  MAX_SPEED_DM_PER_TICK,
  SERVICE_BRAKE_PERIOD_TICKS,
} from "../sim/constants";

/**
 * Integer train kinematics. Speed drops by 1 dm/tick on every tick divisible by
 * the brake period, so the exact remaining braking distance depends on the phase
 * of the tick counter. Both forms below are closed-form integer arithmetic; no
 * square roots and no floating point reach the tick path.
 */

/** Ticks from tick k until and including the next tick whose speed step lands. */
function ticksToNextStep(k: number, period: number): number {
  return ((period - (k % period)) % period) + 1;
}

/**
 * Exact distance covered from tick k until standstill when braking continuously
 * at speed v. The train moves at the current speed first, then the step lands.
 */
export function stopDistance(v: number, k: number, period: number): number {
  if (v <= 0) return 0;
  return v * ticksToNextStep(k, period) + period * (((v - 1) * v) / 2);
}

function buildTable(period: number): readonly number[] {
  const table: number[] = [];
  for (let v = 0; v <= MAX_SPEED_DM_PER_TICK; v++) table.push((period * v * (v + 1)) / 2);
  return table;
}

const SERVICE_TABLE = buildTable(SERVICE_BRAKE_PERIOD_TICKS);
const EMERGENCY_TABLE = buildTable(EMERGENCY_BRAKE_PERIOD_TICKS);

function lookup(table: readonly number[], v: number): number {
  const entry = table[v];
  if (entry === undefined) throw new Error(`speed ${v} dm/tick is outside the braking table`);
  return entry;
}

/** Worst-case service braking distance from speed v, whatever the tick phase. */
export function brakeDistance(vDmPerTick: number): number {
  return lookup(SERVICE_TABLE, vDmPerTick);
}

/** Worst-case emergency braking distance from speed v, whatever the tick phase. */
export function emergencyBrakeDistance(vDmPerTick: number): number {
  return lookup(EMERGENCY_TABLE, vDmPerTick);
}
