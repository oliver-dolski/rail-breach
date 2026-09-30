/**
 * Derived output of a step, consumed by the renderer and the UI. Events are
 * never persisted in recordings: a recording holds only the inputs.
 */
export type SimEvent =
  | { k: "technique.succeeded"; tick: number; technique: string; node: string }
  | { k: "technique.failed"; tick: number; technique: string; node: string }
  | { k: "action.rejected"; tick: number; reason: "unknown-node" };
