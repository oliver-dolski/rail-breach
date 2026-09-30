import { type Action, applyAction } from "./actions";
import type { SimEvent } from "./events";
import { cloneWorld, type World } from "./world";

export interface StepResult {
  world: World;
  events: SimEvent[];
}

/**
 * Advances the world by exactly one integer tick. Pure: the input is never
 * mutated and identical inputs give byte-identical output. Actions passed in
 * are the ones due at the tick this step produces (world.tick + 1).
 *
 * Fixed subsystem order (later plans fill the stubs, the order never changes):
 *   1 apply due actions  2 attack ops  3 detection  4 rail inputs
 *   5 interlocking  6 CTC and timetable  7 trains  8 invariants  9 tick++
 */
export function step(world: World, dueActions: readonly Action[]): StepResult {
  const next = cloneWorld(world);
  const events: SimEvent[] = [];
  const tick = world.tick + 1;

  for (const action of dueActions) applyAction(next, action, tick, events);

  next.tick = tick;
  return { world: next, events };
}
