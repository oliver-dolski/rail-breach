import type { EffectKind } from "../attack/types";
import type { DefenseKind } from "../net/defenses";

/** What a signal shows. Dark means the lamp is out, which drivers treat as stop. */
export type Aspect = "proceed" | "caution" | "stop" | "dark";

export type StopCause = "signal" | "station" | "terminus" | "overrun";

/** Why an action was refused; the world is left as it was. */
export type RejectReason =
  | "unknown-node"
  | "no-index"
  /** A defense named a conduit or link that does not exist, or a conduit without links. */
  | "unknown-target"
  /** A defense config that does not belong to its kind. */
  | "invalid-defense"
  /** A defense that would change nothing because the same one is already there. */
  | "already-placed"
  | "defense-limit"
  /** More playbooks still running than the engine takes on. */
  | "playbook-limit"
  /** A defense.remove for an id that is not placed. */
  | "unknown-defense";

/**
 * Derived output of a step, consumed by the renderer and the UI. Events are
 * never persisted in recordings: a recording holds only the inputs.
 */
export type SimEvent =
  /** The operation finished on `node` and its effects were applied. */
  | { k: "technique.succeeded"; tick: number; op: number; technique: string; node: string }
  /** The operation finished on `node` and the roll went against the attacker. */
  | { k: "technique.failed"; tick: number; op: number; technique: string; node: string }
  | { k: "action.rejected"; tick: number; reason: RejectReason }
  /** A launch that did not meet its preconditions, with each failed one in words. */
  | { k: "technique.rejected"; tick: number; technique: string; target: string; reasons: string[] }
  | { k: "op.started"; tick: number; op: number; technique: string; target: string; from: string }
  /** One hop: the payload leaves `from` now and arrives at `to` on `arriveTick`. */
  | {
      k: "packet";
      tick: number;
      op: number;
      technique: string;
      link: string;
      from: string;
      to: string;
      arriveTick: number;
    }
  /** The link a payload needed stopped permitting its protocol; the operation ends. */
  | { k: "op.blocked"; tick: number; op: number; technique: string; link: string; at: string }
  /** A finished operation changed the state of `node`. */
  | {
      k: "effect.applied";
      tick: number;
      op: number;
      technique: string;
      node: string;
      effect: EffectKind;
    }
  /** A cyber effect on `node` ended: it timed out or a local restoration removed it. */
  | { k: "effect.cleared"; tick: number; node: string; effect: EffectKind }
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
  /** A defense was placed; it is in force from `activeFrom`. `conduit` is "" for a single link. */
  | {
      k: "defense.placed";
      tick: number;
      id: string;
      kind: DefenseKind;
      conduit: string;
      links: string[];
      activeFrom: number;
    }
  | { k: "defense.removed"; tick: number; id: string }
  /**
   * A sensor noticed one hop of an operation. `legacyId` is the technique's old ID or "";
   * `conduit` is "" for a link inside a zone; `sensor` is the placed sensor's id or "baseline".
   */
  | {
      k: "ids.alert";
      tick: number;
      op: number;
      technique: string;
      legacyId: string;
      link: string;
      conduit: string;
      sensor: string;
    }
  | { k: "signal.aspect"; tick: number; signal: string; aspect: Aspect }
  | { k: "interlocking.health"; tick: number; il: string; health: "ok" | "down" }
  | { k: "train.spawned"; tick: number; train: string; service: string }
  | { k: "train.arrived"; tick: number; train: string }
  | { k: "train.stopped"; tick: number; train: string; cause: StopCause; signal?: string }
  | { k: "train.overran"; tick: number; train: string; signal: string };
