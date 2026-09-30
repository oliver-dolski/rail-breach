import { TICKS_PER_SECOND } from "../../core/sim/constants";
import type { World } from "../../core/sim/world";

const seconds = (ticks: number): string => `${Math.floor(ticks / TICKS_PER_SECOND)} s`;

/**
 * The time-to-detect counter as the panel words it: it starts at the attacker's first
 * action and stops at the first IDS alert. Read off two fields of the world, so it
 * is the same on a replay.
 */
export function timeToDetect(
  world: Pick<World, "tick" | "firstActionTick" | "detectedAt">,
): string {
  if (world.firstActionTick === 0) return "no attack yet";
  if (world.detectedAt === 0) {
    return `not noticed, ${seconds(world.tick - world.firstActionTick)} since the first action`;
  }
  return `after ${seconds(world.detectedAt - world.firstActionTick)}`;
}
