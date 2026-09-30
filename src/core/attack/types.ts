import type { NodeKind, Protocol } from "../../content/types";

/**
 * The attack vocabulary. Techniques are data interpreted by one engine, so the
 * interface can explain a rejection ("needs a permitted remote-services path")
 * and a reviewer can audit every possible consequence in one short union.
 */

export type TechniqueId = string;

/**
 * Tactic labels as the ATT&CK for ICS v19.2 bundle spells them (the kill-chain
 * phase names). A technique lists several in the bundle; its definition names the
 * one the engine files it under, and the catalogue test checks it is one of them.
 */
export type TacticId =
  | "initial-access"
  | "persistence"
  | "lateral-movement"
  | "discovery"
  | "evasion"
  | "impair-process-control"
  | "inhibit-response-function"
  | "impact";

/** 1 is a user-level foothold, 2 admin or system. Matches NodeState.integrity. */
export type Privilege = 1 | 2;

/** Which nodes a technique may be aimed at. Every given field must match. */
export interface NodeSelector {
  kinds?: NodeKind[];
  roles?: string[];
  tags?: string[];
}

/**
 * What must hold before a technique may launch. Data, not closures, so a
 * refusal can be reported in words.
 */
export type Precondition =
  /** A permitted path for `protocol` from the attacker's origin to the target. */
  | { k: "reach"; from: "external" | "foothold"; protocol: Protocol }
  /** The attacker already holds the target node. */
  | { k: "targetFoothold"; min: Privilege }
  /** The attacker has already enumerated the target. */
  | { k: "targetDiscovered" };

/**
 * Everything a technique can do to the world. The union is restrictive by
 * construction: each member only adds attacker knowledge or takes something
 * away from the operators. There is deliberately no member that could clear a
 * lock, show a proceed aspect, move a point or move a train, and applyEffect
 * touches nothing but the cyber fields of a NodeState.
 *
 * `onTag` limits an effect to targets carrying that tag.
 */
export type Effect =
  | { k: "foothold"; priv: Privilege }
  | { k: "discover"; hops: number }
  | { k: "blockCommands"; onTag?: string }
  /** `recoverTicks`: the denial lifts by itself that many ticks later; absent means it stays. */
  | { k: "denyControl"; onTag?: string; recoverTicks?: number }
  /** The operators' picture of the node gets worse, never better: ok, spoofed, frozen, blank. */
  | { k: "setView"; state: "spoofed" | "frozen" | "blank" }
  /** The node's availability gets worse, never better: ok, degraded, down. */
  | { k: "degrade"; state: "degraded" | "down" }
  /** Caps a parameter of the node at `permille` of its normal value. Only ever lowered. */
  | { k: "clampParam"; param: "speed"; permille: number };

export type EffectKind = Effect["k"];

/** How much of the target's own defences the success roll must beat. */
export type Resistance = "none" | "host" | "host-and-user";

export interface TechniqueDef {
  /** Current ATT&CK for ICS ID. */
  id: TechniqueId;
  /** The ID this technique had before the v19 restructuring, when it had another. */
  legacyId?: string;
  name: string;
  tactic: TacticId;
  /** What crosses the links. Null means the technique runs on one node and needs no path. */
  protocol: Protocol | null;
  targets: NodeSelector;
  pre: Precondition[];
  /** Ticks the payload spends working on the target once it arrived: [min, max]. */
  durationTicks: [number, number];
  /** Base success chance before the target's resistance is applied. Permille. */
  successPermille: number;
  resistance: Resistance;
  /**
   * How loud the technique is on the wire: the chance, in permille, that one hop of it is
   * noticed by a sensor that sees the whole link. A technique that runs on one node and
   * sends nothing has no hop to notice and says 0.
   */
  signaturePermille: number;
  effects: Effect[];
  /** One sentence for the log and tooltips. */
  explain: string;
}

/**
 * One running technique. Plain JSON, lives in World. While hop < path.length - 1
 * the payload is crossing links[hop] and arrives at path[hop + 1] on `doneAt`;
 * on the last node it works until `doneAt` and then the success roll decides.
 */
export interface Op {
  /** Sequence number, also the dice key that separates simultaneous operations. */
  id: number;
  technique: TechniqueId;
  target: string;
  /** Node ids from the origin to the target, both included. */
  path: string[];
  /** Link ids between consecutive nodes of `path`. */
  links: string[];
  hop: number;
  doneAt: number;
}
