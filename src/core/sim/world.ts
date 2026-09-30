import type { Content } from "../../content/types";
import { internKey } from "../rng";

/**
 * Runtime state. Plain JSON only: objects, arrays, integers, strings, booleans.
 * No Map, Set, class instances or functions, so the state hashes canonically,
 * survives a JSON round-trip and can be cloned by hand. Safety-critical outputs
 * such as signal aspects are never stored here; they are derived every tick.
 */

export type Integrity = 0 | 1 | 2;
export type Availability = "ok" | "degraded" | "down";
export type ViewState = "ok" | "frozen" | "blank" | "spoofed";

export interface NodeState {
  id: string;
  /** Interned uint32 of the id, used as a dice key. Computed at createWorld. */
  key: number;
  /** 0 clean, 1 user-level foothold, 2 admin/system. */
  integrity: Integrity;
  availability: Availability;
  /** Meaningful on hmi and scada nodes. */
  view: ViewState;
  cmdBlocked: boolean;
  controlDenied: boolean;
  discovered: boolean;
}

export interface InterlockingState {
  id: string;
  health: "ok" | "down";
}

export interface TrainState {
  id: string;
  /** Decimetres along the line. */
  posDm: number;
  /** Decimetres per tick. */
  speedDmPerTick: number;
}

export interface World {
  tick: number;
  seed: number;
  nodes: NodeState[];
  interlockings: InterlockingState[];
  trains: TrainState[];
}

/** Total order on ids: ties are impossible because ids are unique. */
export function compareId(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function createWorld(content: Content, seed: number): World {
  const nodes: NodeState[] = [...content.nodes].sort(compareId).map((def) => ({
    id: def.id,
    key: internKey(def.id),
    integrity: 0,
    availability: "ok",
    view: "ok",
    cmdBlocked: false,
    controlDenied: false,
    discovered: false,
  }));
  const interlockings: InterlockingState[] = [...content.interlockings]
    .sort(compareId)
    .map((def) => ({ id: def.id, health: "ok" }));
  const trains: TrainState[] = [...content.trains]
    .sort(compareId)
    .map((def) => ({ id: def.id, posDm: def.startPosDm, speedDmPerTick: 0 }));
  return { tick: 0, seed: seed >>> 0, nodes, interlockings, trains };
}

/** Hand-written clone: keeps the core free of host APIs such as structuredClone. */
export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    seed: world.seed,
    nodes: world.nodes.map((n) => ({ ...n })),
    interlockings: world.interlockings.map((i) => ({ ...i })),
    trains: world.trains.map((t) => ({ ...t })),
  };
}
