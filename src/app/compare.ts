import { InvariantViolation } from "../core/rail/invariants";
import type { Comparison } from "../core/replay/counterfactual";
import { runOutcome } from "../core/replay/counterfactual";
import type { TimedAction } from "../core/replay/recording";
import { cloneWorld } from "../core/sim/world";
import type { AttractSession } from "./session";

/** The actions that change the defenders' side: what a comparison switches on and off. */
export const isDefenseAction = (x: TimedAction): boolean =>
  x.a.type === "defense.place" || x.a.type === "defense.remove";

/** Every action of the session in the order it applies: the recorded ones, then the viewer's. */
const everything = (session: AttractSession): TimedAction[] => [
  ...session.recording.actions,
  ...session.liveActions(),
];

/**
 * How many defense actions the session holds, recorded and live: the scenario's own IDS
 * sensors count. Zero means there is nothing to compare.
 */
export function defenseCount(session: AttractSession): number {
  return everything(session).filter(isDefenseAction).length;
}

/**
 * The same scenario, same seed, from the same starting world to the end of the show, twice:
 * once with no defense at all (the scenario's own sensors and the viewer's switched off) and
 * once with every defense in place, exactly the session as played. Both runs are the real
 * engine and deterministic, so the difference is the defenses and nothing else. Nothing here
 * touches the live session. Undefined when the session holds no defense. The comparison runs
 * with the safety check on, like the live loop: a violation latches the session's indicator
 * as breached and is thrown on, so the caller shows the failure instead of a comparison.
 */
export function compareSession(session: AttractSession): Comparison | undefined {
  if (defenseCount(session) === 0) return undefined;
  const all = everything(session);
  const start = session.startWorld();
  // The quiet stretch has already run, so the scenario's own sensors (placed before the show
  // starts) are in the start world, not in the actions: the bare run takes them out of it.
  const bare = cloneWorld(start);
  bare.defenses = [];
  const end = session.recording.durationTicks;
  try {
    // runOutcome rather than counterfactual(): appending defenses as extra actions would
    // move a recorded defense behind recorded actions of the same tick.
    return {
      undefended: runOutcome(
        bare,
        session.index,
        all.filter((x) => !isDefenseAction(x)),
        end,
      ),
      defended: runOutcome(start, session.index, all, end),
    };
  } catch (error) {
    if (error instanceof InvariantViolation) session.reportViolation(error.violations);
    throw error;
  }
}
