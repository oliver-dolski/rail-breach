import type { Comparison } from "../core/replay/counterfactual";
import { counterfactual } from "../core/replay/counterfactual";
import type { TimedAction } from "../core/replay/recording";
import type { AttractSession } from "./session";

/** The actions that change the defenders' side: what a comparison switches on and off. */
export const isDefenseAction = (x: TimedAction): boolean =>
  x.a.type === "defense.place" || x.a.type === "defense.remove";

/** How many live actions so far were defenses: zero means there is nothing to compare. */
export function defenseCount(session: AttractSession): number {
  return session.liveActions().filter(isDefenseAction).length;
}

/**
 * The same scenario, same seed, from the same starting world to the end of the show, twice:
 * once as recorded (with whatever attacks the viewer launched, and none of their defense
 * changes) and once with those changes. Both runs are the real engine and deterministic, so
 * the difference is the viewer's defenses and nothing else. Nothing here touches the live
 * session. Undefined when no defense has been placed.
 */
export function compareSession(session: AttractSession): Comparison | undefined {
  const live = session.liveActions();
  const defenses = live.filter(isDefenseAction);
  if (defenses.length === 0) return undefined;
  const base = [...session.recording.actions, ...live.filter((x) => !isDefenseAction(x))];
  return counterfactual(
    session.startWorld(),
    session.index,
    base,
    session.recording.durationTicks,
    defenses,
  );
}
