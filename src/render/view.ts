import type { Layout, Pt } from "../content/layout";
import type { Content, NodeKind } from "../content/types";
import type { DefenseInstance } from "../core/net/defenses";
import { deriveAspects } from "../core/rail/interlocking";
import { computeOccupancy, DISTURBED, OCCUPIED } from "../core/rail/trackGraph";
import { TRAIN_LENGTH_DM } from "../core/sim/constants";
import type { Index } from "../core/sim/model";
import type { NodeState, TrainState, World } from "../core/sim/world";
import { type Polyline, pointAt, polyline } from "./geometry";
import {
  ALERT_COLORS,
  DEFENSE_COLORS,
  NEUTRAL,
  NODE_STYLES,
  type NodeVisualState,
  type Rgb,
  type Rgba,
  SHAPE,
  SIGNAL_COLORS,
} from "./palette";

/** One thick line segment, in map units. */
export interface LineInstance {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  /** Glow radius in map units; 0 for none. */
  glow: number;
  /** Dash period in map units; 0 for solid. */
  dash: number;
  color: Rgba;
}

/** One glyph (disc, ring, diamond, ...), in map units. */
export interface DiscInstance {
  x: number;
  y: number;
  radius: number;
  shape: number;
  glow: number;
  color: Rgba;
}

export interface ViewStats {
  trains: number;
  trainsStanding: number;
  signals: number;
  signalsAtStop: number;
  nodes: number;
  nodesCompromised: number;
  nodesLost: number;
  routesSet: number;
  interlockingsDown: number;
}

/**
 * Everything the renderer needs for one frame, as plain data derived from a
 * World snapshot. Layers are listed back to front.
 */
export interface RenderView {
  tick: number;
  /** Fractional tick: tick plus the interpolation alpha. */
  phase: number;
  zones: LineInstance[];
  links: LineInstance[];
  track: LineInstance[];
  routes: LineInstance[];
  trains: LineInstance[];
  signals: DiscInstance[];
  halos: DiscInstance[];
  nodes: DiscInstance[];
  /** One glyph per placed defense, on the link it guards. Faint until it is in force. */
  defenses: DiscInstance[];
  /** The arrow of each diode, showing the way it lets data pass. */
  defenseArrows: LineInstance[];
  stats: ViewStats;
}

export interface ViewOptions {
  /** The world one tick earlier, to smooth train movement. */
  prev?: World;
  /** 0..1 position between prev and world. */
  alpha?: number;
}

interface DrawBlock {
  id: string;
  section: number;
  poly: Polyline;
  station: boolean;
}

/** Static, per-content data for buildView. Built once, never changes. */
export interface ViewContext {
  index: Index;
  layout: Layout;
  links: { id: string; a: Pt; b: Pt; conduit: string }[];
  /** Where each conduit's caption goes: the mean of the middles of its links. */
  conduitMarks: { id: string; label: string; x: number; y: number }[];
  zones: LineInstance[];
  blocks: Map<string, Polyline>;
  drawBlocks: DrawBlock[];
  connectors: LineInstance[];
  /** Where each signal lamp sits, in the order of index.rail.graph.signals. */
  signalAt: Pt[];
  /** Bigger glyphs for the machines that matter most. */
  radiusOf: Map<NodeKind, number>;
}

const STATION_BLOCK_MAX_DM = 5000;

const rgba = (c: Rgb, a: number): Rgba => [c[0], c[1], c[2], a];

function segmentsOf(
  points: readonly Pt[],
  width: number,
  glow: number,
  dash: number,
  color: Rgba,
): LineInstance[] {
  const out: LineInstance[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) out.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, width, glow, dash, color });
  }
  return out;
}

export function createViewContext(content: Content, index: Index, layout: Layout): ViewContext {
  const blocks = new Map<string, Polyline>();
  for (const [id, pts] of Object.entries(layout.blocks)) blocks.set(id, polyline(pts));

  const links = content.links.map((link) => {
    const a = layout.nodes[link.a];
    const b = layout.nodes[link.b];
    if (!a || !b) throw new Error(`layout has no position for link ${link.id}`);
    return {
      id: link.id,
      a: { x: a.x, y: a.y },
      b: { x: b.x, y: b.y },
      conduit: link.conduit ?? "",
    };
  });

  const conduitMarks: ViewContext["conduitMarks"] = [];
  for (const conduit of content.conduits) {
    const members = links.filter((l) => l.conduit === conduit.id);
    if (members.length === 0) continue;
    const x = members.reduce((sum, l) => sum + (l.a.x + l.b.x) / 2, 0) / members.length;
    const y = members.reduce((sum, l) => sum + (l.a.y + l.b.y) / 2, 0) / members.length;
    conduitMarks.push({ id: conduit.id, label: layout.conduits[conduit.id] ?? conduit.name, x, y });
  }

  const zones: LineInstance[] = [];
  for (const z of layout.zones) {
    const corners: Pt[] = [
      { x: z.x, y: z.y },
      { x: z.x + z.w, y: z.y },
      { x: z.x + z.w, y: z.y + z.h },
      { x: z.x, y: z.y + z.h },
      { x: z.x, y: z.y },
    ];
    zones.push(...segmentsOf(corners, 1.4, 0, 9, rgba(NEUTRAL.zone, 0.9)));
  }

  const { graph } = index.rail;
  const drawBlocks: DrawBlock[] = [];
  const seenSections = new Set<number>();
  for (const block of content.tracks.blocks) {
    const poly = blocks.get(block.id);
    const section = graph.blockSection.get(block.id);
    if (!poly || section === undefined)
      throw new Error(`layout has no track for block ${block.id}`);
    if (seenSections.has(section)) continue;
    seenSections.add(section);
    drawBlocks.push({
      id: block.id,
      section,
      poly,
      station: block.lengthDm <= STATION_BLOCK_MAX_DM,
    });
  }

  const connectors = layout.connectors.flatMap((c) =>
    segmentsOf(c, 4, 0, 0, rgba(NEUTRAL.track, 1)),
  );

  const signalAt = graph.signals.map((signal) => {
    const poly = blocks.get(signal.block);
    const block = graph.blocks.get(signal.block);
    if (!poly || !block) throw new Error(`layout has no track for signal ${signal.id}`);
    const at = pointAt(poly, signal.atDm / block.lengthDm);
    // Right-hand running: the lamp stands on the right of the direction of travel.
    return { x: at.x - at.dy * 14, y: at.y + at.dx * 14 };
  });

  const radiusOf = new Map<NodeKind, number>([
    ["external", 10],
    ["scada-server", 10],
    ["interlocking", 9],
    ["front-end-processor", 8.5],
  ]);

  return {
    index,
    layout,
    links,
    conduitMarks,
    zones,
    blocks,
    drawBlocks,
    connectors,
    signalAt,
    radiusOf,
  };
}

/** Distance from a point to a segment, in map units. */
function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy));
}

/**
 * The conduit whose link runs closest to a point on the map, when one runs within
 * maxDistance map units; ties go to the lower conduit id. A link inside a zone belongs
 * to no conduit and is never picked. Pure: this is the map's click target.
 */
export function nearestConduit(ctx: ViewContext, at: Pt, maxDistance: number): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance;
  for (const link of ctx.links) {
    if (link.conduit === "") continue;
    const d = distanceToSegment(at, link.a, link.b);
    if (d < bestDistance || (d === bestDistance && best !== undefined && link.conduit < best)) {
      best = link.conduit;
      bestDistance = d;
    }
  }
  return best;
}

const DEFENSE_GLYPH_RADIUS = 7;
/** Glyphs of several defenses on one link sit this far apart along it. */
const DEFENSE_STACK_STEP = 16;

/**
 * The glyph of every placed defense, and the arrow of every diode. A firewall is a
 * filled disc, a diode a triangle with an arrow along the way it lets data pass, an
 * IDS sensor a ring in the detection colour. One that is not yet in force is drawn
 * faint and without glow, so the placement delay can be seen.
 */
function defenseGlyphs(
  world: World,
  ctx: ViewContext,
  defenses: readonly DefenseInstance[],
): { glyphs: DiscInstance[]; arrows: LineInstance[] } {
  const glyphs: DiscInstance[] = [];
  const arrows: LineInstance[] = [];
  const byLink = new Map<string, { a: Pt; b: Pt }>();
  for (const link of ctx.links) byLink.set(link.id, link);
  const stacked = new Map<string, number>();

  for (const defense of defenses) {
    const link = byLink.get(defense.link);
    if (link === undefined) continue;
    const dx = link.b.x - link.a.x;
    const dy = link.b.y - link.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const slot = stacked.get(defense.link) ?? 0;
    stacked.set(defense.link, slot + 1);
    const along = slot * DEFENSE_STACK_STEP;
    const x = (link.a.x + link.b.x) / 2 + ux * along;
    const y = (link.a.y + link.b.y) / 2 + uy * along;
    const live = world.tick >= defense.activeFrom;
    const base = defense.kind === "ids" ? ALERT_COLORS.detection : DEFENSE_COLORS.barrier;
    const color = rgba(base, live ? 1 : 0.35);
    const shape =
      defense.kind === "firewall"
        ? SHAPE.disc
        : defense.kind === "diode"
          ? SHAPE.triangle
          : SHAPE.ring;
    glyphs.push({ x, y, radius: DEFENSE_GLYPH_RADIUS, shape, glow: live ? 7 : 0, color });

    if (defense.kind === "diode") {
      // The arrow runs beside the glyph, along the way the diode lets data pass.
      const sign = defense.direction === "a-to-b" ? 1 : -1;
      const fx = ux * sign;
      const fy = uy * sign;
      const nx = -fy;
      const ny = fx;
      const offset = 13;
      const tip = { x: x + nx * offset + fx * 11, y: y + ny * offset + fy * 11 };
      const tail = { x: x + nx * offset - fx * 11, y: y + ny * offset - fy * 11 };
      const barb = (side: number): LineInstance => ({
        x0: tip.x,
        y0: tip.y,
        x1: tip.x - fx * 6 + nx * 4 * side,
        y1: tip.y - fy * 6 + ny * 4 * side,
        width: 1.8,
        glow: 0,
        dash: 0,
        color,
      });
      arrows.push(
        { x0: tail.x, y0: tail.y, x1: tip.x, y1: tip.y, width: 1.8, glow: 0, dash: 0, color },
        barb(1),
        barb(-1),
      );
    }
  }
  return { glyphs, arrows };
}

export function nodeVisualState(node: NodeState): NodeVisualState {
  if (node.availability === "down" || node.cmdBlocked || node.controlDenied) return "lost";
  if (node.integrity > 0) return "compromised";
  if (node.availability === "degraded" || node.view !== "ok") return "degraded";
  return "normal";
}

const TRAIN_LENGTH_MIN_PX = 16;

function trainPoint(ctx: ViewContext, train: TrainState, dm: number): Pt | undefined {
  const geometry = ctx.index.rail.graph.services.get(train.service);
  if (!geometry) return undefined;
  const starts = geometry.blockStartDm;
  let i = 0;
  while (i + 1 < starts.length && (starts[i + 1] ?? Number.POSITIVE_INFINITY) <= dm) i++;
  const blockId = geometry.def.path[i];
  const block = blockId === undefined ? undefined : ctx.index.rail.graph.blocks.get(blockId);
  const poly = blockId === undefined ? undefined : ctx.blocks.get(blockId);
  if (!block || !poly) return undefined;
  const f = (dm - (starts[i] ?? 0)) / block.lengthDm;
  const at = pointAt(poly, f);
  return { x: at.x, y: at.y };
}

function trainLine(ctx: ViewContext, train: TrainState, posDm: number): LineInstance | undefined {
  const head = trainPoint(ctx, train, posDm);
  const tail = trainPoint(ctx, train, posDm - TRAIN_LENGTH_DM);
  if (!head || !tail) return undefined;
  let tx = tail.x;
  let ty = tail.y;
  const span = Math.hypot(head.x - tx, head.y - ty);
  if (span < TRAIN_LENGTH_MIN_PX) {
    // A short block on the sheet: stretch the glyph backwards so it stays readable.
    const probe = trainPoint(ctx, train, posDm - 200);
    const ux = probe ? head.x - probe.x : 1;
    const uy = probe ? head.y - probe.y : 0;
    const norm = Math.hypot(ux, uy) || 1;
    tx = head.x - (ux / norm) * TRAIN_LENGTH_MIN_PX;
    ty = head.y - (uy / norm) * TRAIN_LENGTH_MIN_PX;
  }
  return {
    x0: tx,
    y0: ty,
    x1: head.x,
    y1: head.y,
    width: 7,
    glow: 6,
    dash: 0,
    color: rgba(NEUTRAL.train, 1),
  };
}

const aspectStyle = (aspect: string): { color: Rgba; shape: number; glow: number } => {
  if (aspect === "proceed")
    return { color: rgba(SIGNAL_COLORS.proceed, 1), shape: SHAPE.lamp, glow: 8 };
  if (aspect === "caution")
    return { color: rgba(SIGNAL_COLORS.caution, 1), shape: SHAPE.lamp, glow: 8 };
  if (aspect === "stop") return { color: rgba(SIGNAL_COLORS.stop, 1), shape: SHAPE.lamp, glow: 6 };
  return { color: rgba(NEUTRAL.lampDark, 1), shape: SHAPE.ring, glow: 0 };
};

/**
 * Turns a World snapshot into draw data. Pure: the same snapshot and options
 * always give a deeply equal result, and the world is never written to.
 */
export function buildView(world: World, ctx: ViewContext, opts: ViewOptions = {}): RenderView {
  const { index, layout } = ctx;
  const { graph } = index.rail;
  const alpha = Math.min(1, Math.max(0, opts.alpha ?? 0));
  // Drawing between prev and world: the clock runs from prev, so particles and pulses stay in step.
  const phase = (opts.prev?.tick ?? world.tick) + alpha;
  const pulse = 0.5 + 0.5 * Math.sin((phase * Math.PI * 2) / 24);

  const occupancy = computeOccupancy(world, graph);
  const aspects = deriveAspects(world, index);

  const links: LineInstance[] = ctx.links.flatMap((link) =>
    segmentsOf(
      [link.a, link.b],
      link.conduit !== "" ? 2 : 1.4,
      0,
      0,
      rgba(NEUTRAL.link, link.conduit !== "" ? 1 : 0.85),
    ),
  );

  const track: LineInstance[] = [];
  for (const block of ctx.drawBlocks) {
    const state = occupancy[block.section];
    const color =
      state === OCCUPIED
        ? rgba(NEUTRAL.trackOccupied, 1)
        : state === DISTURBED
          ? rgba(ALERT_COLORS.degraded, 1)
          : rgba(NEUTRAL.track, 1);
    const glow = state === DISTURBED ? 5 : 0;
    track.push(...segmentsOf(block.poly.pts, block.station ? 9 : 5, glow, 0, color));
  }
  track.push(...ctx.connectors);

  // Routes the interlockings hold and no train has entered yet.
  const routes: LineInstance[] = [];
  let routesSet = 0;
  for (const il of world.interlockings) {
    for (const lock of il.locks) {
      routesSet++;
      if (lock.used) continue;
      const info = index.rail.routes.byId.get(lock.route);
      if (!info) continue;
      for (const blockId of info.def.blocks) {
        const poly = ctx.blocks.get(blockId);
        if (poly)
          routes.push(...segmentsOf(poly.pts, 2.4, 3, 0, rgba(SIGNAL_COLORS.proceed, 0.85)));
      }
    }
  }

  const prevById = new Map<string, TrainState>();
  for (const t of opts.prev?.trains ?? []) prevById.set(t.id, t);
  const trains: LineInstance[] = [];
  let standing = 0;
  for (const train of world.trains) {
    if (train.speedDmPerTick === 0) standing++;
    const before = prevById.get(train.id);
    const posDm = before ? before.posDm + (train.posDm - before.posDm) * alpha : train.posDm;
    const drawn = trainLine(ctx, train, posDm);
    if (drawn) trains.push(drawn);
  }

  let atStop = 0;
  const signals: DiscInstance[] = graph.signals.map((_signal, i) => {
    const aspect = aspects[i] ?? "dark";
    if (aspect === "stop" || aspect === "dark") atStop++;
    const at = ctx.signalAt[i] ?? { x: 0, y: 0 };
    const style = aspectStyle(aspect);
    return {
      x: at.x,
      y: at.y,
      radius: 5.4,
      shape: style.shape,
      glow: style.glow,
      color: style.color,
    };
  });

  const nodes: DiscInstance[] = [];
  const halos: DiscInstance[] = [];
  let compromised = 0;
  let lost = 0;
  for (const node of world.nodes) {
    const at = layout.nodes[node.id];
    if (!at) continue;
    const state = nodeVisualState(node);
    const style = NODE_STYLES[state];
    const radius = ctx.radiusOf.get(node.kind) ?? 7.5;
    if (node.integrity > 0) compromised++;
    if (state === "lost") lost++;
    nodes.push({
      x: at.x,
      y: at.y,
      radius,
      shape: SHAPE[style.shape],
      glow: state === "normal" ? 2 : 9,
      color: rgba(style.color, 1),
    });
    if (state === "normal" && node.discovered) {
      halos.push({
        x: at.x,
        y: at.y,
        radius: radius + 6,
        shape: SHAPE.ring,
        glow: 4,
        color: rgba(ALERT_COLORS.attacker, 0.55),
      });
    }
  }

  // A technique working on its target pulses a ring around it.
  for (const op of world.ops) {
    if (op.hop < op.path.length - 1) continue;
    const at = layout.nodes[op.target];
    if (!at) continue;
    halos.push({
      x: at.x,
      y: at.y,
      radius: 14 + 5 * pulse,
      shape: SHAPE.ring,
      glow: 8,
      color: rgba(ALERT_COLORS.attacker, 0.5 + 0.4 * pulse),
    });
  }

  const guards = defenseGlyphs(world, ctx, world.defenses);

  return {
    tick: world.tick,
    phase,
    zones: ctx.zones,
    links,
    track,
    routes,
    trains,
    signals,
    halos,
    nodes,
    defenses: guards.glyphs,
    defenseArrows: guards.arrows,
    stats: {
      trains: world.trains.length,
      trainsStanding: standing,
      signals: graph.signals.length,
      signalsAtStop: atStop,
      nodes: world.nodes.length,
      nodesCompromised: compromised,
      nodesLost: lost,
      routesSet,
      interlockingsDown: world.interlockings.filter((i) => i.health === "down").length,
    },
  };
}
