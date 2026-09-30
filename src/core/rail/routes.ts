import type { RouteDef, SignalDef, TrackContent } from "../../content/types";
import type { PointState, World } from "../sim/world";
import { compareId } from "../sim/world";
import { buildTrackGraph, FREE, OCCUPIED, type TrackGraph } from "./trackGraph";

export interface RouteInfo {
  def: RouteDef;
  il: string;
  entry: SignalDef;
  /** The signal at the far end of the last route block, if the route ends at one. */
  endSignal: SignalDef | undefined;
  blockSections: number[];
  overlapSections: number[];
}

export interface RouteTable {
  /** Sorted by id. */
  routes: RouteInfo[];
  byId: Map<string, RouteInfo>;
  /** Key: `${entrySignal}>${firstBlock}`, the route a service takes from a signal. */
  byEntryNext: Map<string, RouteInfo>;
}

/** Everything static the rail subsystems need, built once by buildIndex. */
export interface RailIndex {
  graph: TrackGraph;
  routes: RouteTable;
}

export function entryNextKey(signalId: string, firstBlock: string): string {
  return `${signalId}>${firstBlock}`;
}

export function buildRailIndex(tracks: TrackContent): RailIndex {
  const graph = buildTrackGraph(tracks);
  const routes = buildRouteTable(tracks, graph);
  return { graph, routes };
}

function buildRouteTable(tracks: TrackContent, graph: TrackGraph): RouteTable {
  const infos: RouteInfo[] = [];
  const byId = new Map<string, RouteInfo>();
  const byEntryNext = new Map<string, RouteInfo>();
  const sectionOf = (block: string): number => {
    const s = graph.blockSection.get(block);
    if (s === undefined) throw new Error(`route names unknown block "${block}"`);
    return s;
  };
  for (const def of [...tracks.routes].sort(compareId)) {
    const entry = graph.signalById.get(def.entrySignal);
    if (!entry)
      throw new Error(`route "${def.id}" names unknown entry signal "${def.entrySignal}"`);
    const last = def.blocks[def.blocks.length - 1];
    const info: RouteInfo = {
      def,
      il: def.interlocking,
      entry,
      endSignal: last === undefined ? undefined : graph.endSignalOfBlock.get(last),
      blockSections: def.blocks.map(sectionOf),
      overlapSections: def.overlap.map(sectionOf),
    };
    infos.push(info);
    byId.set(def.id, info);
    const first = def.blocks[0];
    if (first !== undefined) byEntryNext.set(entryNextKey(def.entrySignal, first), info);
  }

  for (const geometry of graph.services.values()) {
    for (const ps of geometry.sigs) {
      const i = geometry.def.path.indexOf(ps.signal.block);
      const nextBlock = geometry.def.path[i + 1];
      if (nextBlock === undefined) continue;
      ps.routeId = byEntryNext.get(entryNextKey(ps.signal.id, nextBlock))?.def.id;
    }
  }
  return { routes: infos, byId, byEntryNext };
}

function intersects(a: readonly number[], b: readonly number[]): boolean {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

/**
 * True when `requested` cannot be locked while `locked` is held. Not symmetric on
 * purpose: the route that continues from a route's end signal may share that
 * route's overlap (the train runs from one into the other), but the route behind
 * a held continuation may not, because its overlap would sit on live track.
 */
export function conflictsWith(locked: RouteInfo, requested: RouteInfo): boolean {
  if (intersects(locked.blockSections, requested.blockSections)) return true;
  if (intersects(requested.overlapSections, locked.blockSections)) return true;
  if (
    intersects(locked.overlapSections, requested.blockSections) &&
    requested.entry.id !== locked.endSignal?.id
  ) {
    return true;
  }
  for (const want of requested.def.points) {
    for (const have of locked.def.points) {
      if (have.point === want.point && have.pos !== want.pos) return true;
    }
  }
  return false;
}

export function pointState(world: World, id: string): PointState | undefined {
  return world.points.find((p) => p.id === id);
}

export type Proof = { ok: true } | { ok: false; reason: string };

/**
 * The steady-state part of a proof, re-checked every tick by deriveAspect:
 * sections and overlap free, every point in position and detected.
 */
export function routeStillProved(world: World, route: RouteInfo, occ: Uint8Array): boolean {
  for (const s of route.blockSections) if (occ[s] !== FREE) return false;
  for (const s of route.overlapSections) if (occ[s] !== FREE) return false;
  for (const want of route.def.points) {
    const p = pointState(world, want.point);
    if (!p || p.pos !== want.pos || p.moving !== 0) return false;
  }
  return true;
}

/**
 * The full proof required before a route may be locked. Returns the first
 * failing precondition in plain words so a rejection can be shown to a person.
 */
export function proveRoute(
  world: World,
  rail: RailIndex,
  route: RouteInfo,
  occ: Uint8Array,
): Proof {
  const { graph, routes } = rail;
  for (const il of world.interlockings) {
    for (const lock of il.locks) {
      if (lock.route === route.def.id) return { ok: false, reason: "route is already set" };
      const held = routes.byId.get(lock.route);
      if (held && conflictsWith(held, route)) {
        return { ok: false, reason: `conflicts with locked route ${lock.route}` };
      }
    }
  }
  for (const s of route.blockSections) {
    const name = graph.sections[s];
    if (occ[s] === OCCUPIED) return { ok: false, reason: `section ${name} is occupied` };
    if (occ[s] !== FREE) return { ok: false, reason: `section ${name} is disturbed` };
  }
  for (const s of route.overlapSections) {
    const name = graph.sections[s];
    if (occ[s] === OCCUPIED) return { ok: false, reason: `overlap section ${name} is occupied` };
    if (occ[s] !== FREE) return { ok: false, reason: `overlap section ${name} is disturbed` };
  }
  const zoneOf = (id: string): number[] =>
    (graph.points.get(id)?.zone ?? []).flatMap((z) => {
      const s = graph.sectionIx.get(z);
      return s === undefined ? [] : [s];
    });

  for (const want of route.def.points) {
    const p = pointState(world, want.point);
    if (!p || !graph.points.has(want.point)) {
      return { ok: false, reason: `point ${want.point} is unknown` };
    }
    if (p.target === want.pos) continue;
    const zone = zoneOf(want.point);
    for (const s of zone) {
      if (occ[s] !== FREE) {
        return {
          ok: false,
          reason: `point ${want.point} cannot move while section ${graph.sections[s]} is not clear`,
        };
      }
    }
    for (const il of world.interlockings) {
      for (const lock of il.locks) {
        const held = routes.byId.get(lock.route);
        if (held && intersects(held.blockSections, zone)) {
          return {
            ok: false,
            reason: `point ${want.point} cannot move while route ${lock.route} runs through its zone`,
          };
        }
      }
    }
  }
  for (const p of world.points) {
    if (p.moving === 0) continue;
    if (route.def.points.some((w) => w.point === p.id && w.pos === p.target)) continue;
    if (intersects(route.blockSections, zoneOf(p.id))) {
      return { ok: false, reason: `point ${p.id} is still moving` };
    }
  }
  return { ok: true };
}
