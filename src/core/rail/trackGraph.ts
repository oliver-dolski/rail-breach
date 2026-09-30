import type { BlockDef, PointDef, ServiceDef, SignalDef, TrackContent } from "../../content/types";
import { TRAIN_LENGTH_DM } from "../sim/constants";
import { compareId, type TrainState, type World } from "../sim/world";

/** Section occupancy as the interlocking sees it. DISTURBED is treated like OCCUPIED. */
export const FREE = 0;
export const OCCUPIED = 1;
export const DISTURBED = 2;

export interface PathSignal {
  signal: SignalDef;
  /** Distance from the start of the service path. */
  posDm: number;
  /** The route this service takes from the signal; filled in once routes are built. */
  routeId: string | undefined;
}

export interface PathStop {
  posDm: number;
  dwellTicks: number;
}

/** A service path laid out as one straight line of distances, for integer kinematics. */
export interface ServiceGeometry {
  def: ServiceDef;
  lengthDm: number;
  blockStartDm: number[];
  /** Section index of each path block. */
  pathSections: number[];
  /** Signals the train meets, in order. Signals at the very end of the path are omitted. */
  sigs: PathSignal[];
  stops: PathStop[];
}

/** Everything static about the track, built once from content. Never part of World. */
export interface TrackGraph {
  vmaxDmPerTick: number;
  blocks: Map<string, BlockDef>;
  /** Sorted section ids; an index into this array identifies a section everywhere else. */
  sections: string[];
  sectionIx: Map<string, number>;
  blockSection: Map<string, number>;
  signals: SignalDef[];
  signalById: Map<string, SignalDef>;
  signalsOfInterlocking: Map<string, SignalDef[]>;
  /** The signal standing at the far end of a block, if any. */
  endSignalOfBlock: Map<string, SignalDef>;
  points: Map<string, PointDef>;
  services: Map<string, ServiceGeometry>;
}

function sectionIndex(graph: Pick<TrackGraph, "sectionIx">, id: string): number {
  const ix = graph.sectionIx.get(id);
  if (ix === undefined) throw new Error(`unknown section "${id}"`);
  return ix;
}

export function buildTrackGraph(tracks: TrackContent): TrackGraph {
  const blocks = new Map<string, BlockDef>();
  for (const block of tracks.blocks) blocks.set(block.id, block);

  const sections = [...new Set(tracks.blocks.map((b) => b.section))].sort();
  const sectionIx = new Map<string, number>();
  sections.forEach((id, i) => {
    sectionIx.set(id, i);
  });
  const blockSection = new Map<string, number>();
  for (const block of tracks.blocks) {
    blockSection.set(block.id, sectionIndex({ sectionIx }, block.section));
  }

  const signals = [...tracks.signals].sort(compareId);
  const signalById = new Map<string, SignalDef>();
  const signalsOfInterlocking = new Map<string, SignalDef[]>();
  const endSignalOfBlock = new Map<string, SignalDef>();
  for (const signal of signals) {
    signalById.set(signal.id, signal);
    const list = signalsOfInterlocking.get(signal.interlocking);
    if (list) list.push(signal);
    else signalsOfInterlocking.set(signal.interlocking, [signal]);
    const block = blocks.get(signal.block);
    if (block && signal.atDm === block.lengthDm) endSignalOfBlock.set(block.id, signal);
  }

  const points = new Map<string, PointDef>();
  for (const point of tracks.points) points.set(point.id, point);

  const graph: TrackGraph = {
    vmaxDmPerTick: tracks.vmaxDmPerTick,
    blocks,
    sections,
    sectionIx,
    blockSection,
    signals,
    signalById,
    signalsOfInterlocking,
    endSignalOfBlock,
    points,
    services: new Map(),
  };

  for (const def of [...tracks.services].sort(compareId)) {
    graph.services.set(def.id, buildGeometry(def, graph));
  }
  return graph;
}

function buildGeometry(def: ServiceDef, graph: TrackGraph): ServiceGeometry {
  const blockStartDm: number[] = [];
  const pathSections: number[] = [];
  let at = 0;
  for (const id of def.path) {
    const block = graph.blocks.get(id);
    if (!block) throw new Error(`service "${def.id}" path names unknown block "${id}"`);
    blockStartDm.push(at);
    pathSections.push(sectionIndex(graph, block.section));
    at += block.lengthDm;
  }
  const lengthDm = at;

  const sigs: PathSignal[] = [];
  def.path.forEach((id, i) => {
    const start = blockStartDm[i] ?? 0;
    const onBlock = graph.signals
      .filter((s) => s.block === id)
      .sort((a, b) => a.atDm - b.atDm || compareId(a, b));
    for (const signal of onBlock) {
      const posDm = start + signal.atDm;
      if (posDm < lengthDm) sigs.push({ signal, posDm, routeId: undefined });
    }
  });

  const stops: PathStop[] = [];
  let searchFrom = 0;
  for (const stop of def.stops) {
    const i = def.path.indexOf(stop.block, searchFrom);
    if (i < 0)
      throw new Error(`service "${def.id}" stops at "${stop.block}" which is not on its path`);
    const block = graph.blocks.get(stop.block);
    stops.push({
      posDm: (blockStartDm[i] ?? 0) + (block?.lengthDm ?? 0),
      dwellTicks: stop.dwellTicks,
    });
    searchFrom = i + 1;
  }
  return { def, lengthDm, blockStartDm, pathSections, sigs, stops };
}

/** Section indexes a train currently covers. The head has entered a block once it is past its start. */
export function trainSections(train: TrainState, graph: TrackGraph): number[] {
  const geometry = graph.services.get(train.service);
  if (!geometry) return [];
  const head = train.posDm;
  const tail = head - TRAIN_LENGTH_DM;
  const out: number[] = [];
  for (let i = 0; i < geometry.blockStartDm.length; i++) {
    const start = geometry.blockStartDm[i] ?? 0;
    if (start >= head) break;
    const block = graph.blocks.get(geometry.def.path[i] ?? "");
    if (!block) continue;
    if (start + block.lengthDm > tail) {
      const s = geometry.pathSections[i];
      if (s !== undefined && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Per-section state for the current world: FREE, OCCUPIED by a train, or DISTURBED. */
export function computeOccupancy(world: World, graph: TrackGraph): Uint8Array {
  const state = new Uint8Array(graph.sections.length);
  for (const train of world.trains) {
    for (const s of trainSections(train, graph)) state[s] = OCCUPIED;
  }
  for (const id of world.disturbed) {
    const s = graph.sectionIx.get(id);
    if (s !== undefined && state[s] === FREE) state[s] = DISTURBED;
  }
  return state;
}
