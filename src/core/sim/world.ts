import type { Content, NodeKind, PointPos } from "../../content/types";
import type { Op } from "../attack/types";
import { internKey } from "../rng";
import { PERMILLE } from "./constants";

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
  kind: NodeKind;
  /** Interlocking this node belongs to, or "" for nodes outside the track side. */
  controls: string;
  /** 0 clean, 1 user-level foothold, 2 admin/system. */
  integrity: Integrity;
  availability: Availability;
  /** Meaningful on hmi and scada nodes. */
  view: ViewState;
  cmdBlocked: boolean;
  controlDenied: boolean;
  /**
   * Tick at which a temporary denial of control lifts by itself, or 0 when the denial
   * has no end (or there is none). Only ever pushed later by an attack.
   */
  controlRecoverAt: number;
  discovered: boolean;
  /**
   * Cap on the line speed the node's sections allow, in permille of normal. Starts
   * at 1000 and is only ever lowered by an attack; a local restoration raises it.
   */
  paramClampPermille: number;
}

export type RequestSource = "ctc" | "operator";

export interface RouteRequest {
  route: string;
  kind: "set" | "cancel";
  by: RequestSource;
  /** Tick the request entered the queue. */
  tick: number;
}

/** A route the interlocking holds. `used` turns true once a train enters it. */
export interface RouteLock {
  route: string;
  used: boolean;
}

export interface InterlockingState {
  id: string;
  /** Latest restrictive input from the cyber side, copied in by the interlocking step. */
  health: "ok" | "down";
  cmdBlocked: boolean;
  /** Sorted by route id. */
  locks: RouteLock[];
  /** FIFO; processed in (tick, route) order so ties are deterministic. */
  queue: RouteRequest[];
}

export interface PointState {
  id: string;
  pos: PointPos;
  target: PointPos;
  /** Ticks until the blades arrive at target; 0 means detected. */
  moving: number;
}

export interface TrainState {
  id: string;
  service: string;
  /** Decimetres from the start of the service path to the front of the train. */
  posDm: number;
  /** Decimetres per tick. */
  speedDmPerTick: number;
  /** Index of the next signal on the service path the front has not yet passed. */
  sig: number;
  /** Index of the next timetabled stop not yet served. */
  stop: number;
  /** Ticks left of a dwell or recovery wait; the train does not move while > 0. */
  dwell: number;
  /** Index of a path signal passed at danger, or -1. */
  overrun: number;
  /** Tick of the last route request made for this train. */
  lastReq: number;
}

export interface ServiceState {
  id: string;
  /** Departures already released to the network. */
  released: number;
}

export interface World {
  tick: number;
  seed: number;
  nodes: NodeState[];
  interlockings: InterlockingState[];
  trains: TrainState[];
  points: PointState[];
  services: ServiceState[];
  /** Attack operations in flight, in launch order. */
  ops: Op[];
  /** Number of operations ever launched; the next operation gets this id. */
  opSeq: number;
  /** Sections the interlocking must treat as occupied (restrictive input, sorted). */
  disturbed: string[];
  /** Signals forced dark by a failed object controller (restrictive input, sorted). */
  darkSignals: string[];
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
    kind: def.kind,
    controls: def.controls ?? "",
    integrity: 0,
    availability: "ok",
    view: "ok",
    cmdBlocked: false,
    controlDenied: false,
    controlRecoverAt: 0,
    discovered: false,
    paramClampPermille: PERMILLE,
  }));
  const interlockings: InterlockingState[] = [...content.interlockings]
    .sort(compareId)
    .map((def) => ({ id: def.id, health: "ok", cmdBlocked: false, locks: [], queue: [] }));
  const points: PointState[] = [...content.tracks.points]
    .sort(compareId)
    .map((def) => ({ id: def.id, pos: "normal", target: "normal", moving: 0 }));
  const services: ServiceState[] = [...content.tracks.services]
    .sort(compareId)
    .map((def) => ({ id: def.id, released: 0 }));
  return {
    tick: 0,
    seed: seed >>> 0,
    nodes,
    interlockings,
    trains: [],
    points,
    services,
    ops: [],
    opSeq: 0,
    disturbed: [],
    darkSignals: [],
  };
}

/** Hand-written clone: keeps the core free of host APIs such as structuredClone. */
export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    seed: world.seed,
    nodes: world.nodes.map((n) => ({ ...n })),
    interlockings: world.interlockings.map((i) => ({
      ...i,
      locks: i.locks.map((l) => ({ ...l })),
      queue: i.queue.map((q) => ({ ...q })),
    })),
    trains: world.trains.map((t) => ({ ...t })),
    points: world.points.map((p) => ({ ...p })),
    services: world.services.map((s) => ({ ...s })),
    ops: world.ops.map((o) => ({ ...o, path: [...o.path], links: [...o.links] })),
    opSeq: world.opSeq,
    disturbed: [...world.disturbed],
    darkSignals: [...world.darkSignals],
  };
}
