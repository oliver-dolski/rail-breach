/** What a signal shows. Dark means the lamp is out, which drivers treat as stop. */
export type Aspect = "proceed" | "caution" | "stop" | "dark";

export type StopCause = "signal" | "station" | "terminus" | "overrun";

/**
 * Derived output of a step, consumed by the renderer and the UI. Events are
 * never persisted in recordings: a recording holds only the inputs.
 */
export type SimEvent =
  | { k: "technique.succeeded"; tick: number; technique: string; node: string }
  | { k: "technique.failed"; tick: number; technique: string; node: string }
  | { k: "action.rejected"; tick: number; reason: "unknown-node" }
  | {
      k: "command.rejected";
      tick: number;
      /** Interlocking that refused the command, or "" when the route is unknown. */
      il: string;
      route: string;
      by: string;
      /** Which precondition failed, in plain words. */
      reason: string;
    }
  | { k: "route.set"; tick: number; il: string; route: string; by: string }
  | { k: "route.released"; tick: number; il: string; route: string; cause: "cleared" | "cancelled" }
  | { k: "signal.aspect"; tick: number; signal: string; aspect: Aspect }
  | { k: "interlocking.health"; tick: number; il: string; health: "ok" | "down" }
  | { k: "train.spawned"; tick: number; train: string; service: string }
  | { k: "train.arrived"; tick: number; train: string }
  | { k: "train.stopped"; tick: number; train: string; cause: StopCause; signal?: string }
  | { k: "train.overran"; tick: number; train: string; signal: string };
