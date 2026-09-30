import { stepCtc, stepTimetable } from "../rail/ctc";
import { deriveAspects, stepInterlocking } from "../rail/interlocking";
import { stepTrains } from "../rail/trains";
import { type Action, applyAction } from "./actions";
import type { SimEvent } from "./events";
import type { Index } from "./model";
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
 * `index` is the static data derived from content. Without it only the cyber
 * side steps, which keeps small cyber-only fixtures usable.
 *
 * Fixed subsystem order (later plans fill the stubs, the order never changes):
 *   1 apply due actions  2 attack ops  3 detection  4 rail inputs
 *   5 interlocking  6 CTC and timetable  7 trains  8 invariants
 * Rail inputs (4) are derived at the top of the interlocking step (5).
 */
export function step(world: World, dueActions: readonly Action[], index?: Index): StepResult {
  const next = cloneWorld(world);
  const events: SimEvent[] = [];
  const tick = world.tick + 1;
  next.tick = tick;

  const before = index === undefined ? [] : deriveAspects(world, index);

  for (const action of dueActions) applyAction(next, action, tick, events, index);

  if (index !== undefined) {
    stepInterlocking(next, index, events);
    stepTimetable(next, index, events);
    stepCtc(next, index, events);
    stepTrains(next, index, events);

    const after = deriveAspects(next, index);
    index.rail.graph.signals.forEach((signal, i) => {
      const aspect = after[i];
      if (aspect !== undefined && aspect !== before[i]) {
        events.push({ k: "signal.aspect", tick, signal: signal.id, aspect });
      }
    });
  }

  return { world: next, events };
}
