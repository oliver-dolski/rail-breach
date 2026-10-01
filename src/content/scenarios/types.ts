import type { PlaybookStep } from "../../core/attack/types";
import type { TimedAction } from "../../core/replay/recording";

/**
 * A scenario is an ordered list of already-resolved actions plus the seed that
 * decides every roll. Nothing else is stored: no free text, no key, no output
 * of any model. Replaying it never leaves the engine.
 */
export interface Scenario {
  id: string;
  title: string;
  /** One sentence for the selector: who the intruder is and how they get in. */
  summary: string;
  /**
   * What the panel says before the first attack event: where to look on the map, in the
   * map's words. Display only, not part of the recording.
   */
  idleCaption: string;
  seed: number;
  /**
   * Tick at which attract mode starts showing the session. The engine runs the
   * quiet stretch before it in one go, so the viewer meets a railway that is
   * already busy and sees the first packet within a second, at normal speed.
   * A playback choice only: it is not part of the recording.
   */
  startTick: number;
  /** Length of the recorded session in ticks (10 ticks are one simulated second). */
  durationTicks: number;
  /**
   * Nodes the intruder already holds when the scenario begins (assumed breach: an insider,
   * a stolen account). They are applied at the first tick as assume.breach actions, which
   * are part of `actions`, so the recording replays on its own.
   */
  initialFootholds: readonly string[];
  actions: TimedAction[];
}

/** One technique launched at one node at tick `t`. */
export const launch = (t: number, technique: string, target: string): TimedAction => ({
  t,
  a: { type: "technique.launch", technique, target },
});

/** A chain run one step after the other, each starting when the one before has ended. */
export const playbook = (t: number, steps: PlaybookStep[]): TimedAction => ({
  t,
  a: { type: "playbook.start", steps },
});

/** One step of a playbook, aimed at a named node. */
export const stepAt = (technique: string, node: string): PlaybookStep => ({
  technique,
  target: { node },
});

/** An IDS sensor on a conduit, in force 2 s after `t`. */
export const sensorOn = (t: number, conduit: string): TimedAction => ({
  t,
  a: { type: "defense.place", kind: "ids", on: { conduit } },
});

/** The assume.breach actions that give the intruder their starting footholds at the first tick. */
export const footholdActions = (nodes: readonly string[]): TimedAction[] =>
  nodes.map((node) => ({ t: 1, a: { type: "assume.breach", node } }));
