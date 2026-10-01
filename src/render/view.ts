import type { Layout, Pt } from "../content/layout";
import type { Content, NodeKind } from "../content/types";
import type { DefenseInstance } from "../core/net/defenses";
import { deriveAspects } from "../core/rail/interlocking";
import { computeOccupancy, DISTURBED, FREE, OCCUPIED } from "../core/rail/trackGraph";
import { TRAIN_LENGTH_DM } from "../core/sim/constants";
import type { Index } from "../core/sim/model";
import type { NodeState, TrainState, ViewState, World } from "../core/sim/world";
import type { AlertLevel } from "./flashes";
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

/**
 * Which picture of the line is drawn. Ground truth is the railway as it is. The operator
 * view is what the dispatchers' consoles say about it: the same world, read through the
 * state of the supervisory machines, so a spoofed or frozen feed shows in it and nowhere else.
 */
export type ViewMode = "ground-truth" | "operator";

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
  /** Links an IDS alert has just lit up, in the detection hue. Empty without alerts. */
  alerts: LineInstance[];
  mode: ViewMode;
  /** The state of the operators' feed in this world, whichever picture is drawn. */
  reporting: ViewState;
  /** Trains drawn on the map: fewer than stats.trains when the operator picture hides some. */
  trainsShown: number;
  /** Counts always describe the real railway, so the panel never shows a spoofed number. */
  stats: ViewStats;
}

export interface ViewOptions {
  /** The world one tick earlier, to smooth train movement. */
  prev?: World;
  /** 0..1 position between prev and world. */
  alpha?: number;
  /** Ground truth by default. */
  mode?: ViewMode;
  /**
   * An earlier snapshot from when the operators' feed was still good, which is what a
   * frozen console keeps showing. Held by the caller like `prev`; it is only ever read.
   * Without it a frozen feed is drawn as unknown.
   */
  lastGood?: World;
  /** How brightly each link an IDS alert lit up is lit right now (see flashes.ts). */
  alerts?: readonly AlertLevel[];
}

interface DrawBlock {
  id: string;
  section: number;
  poly: Polyline;
  station: boolean;
}

interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Static, per-content data for buildView. Built once, never changes. */
export interface ViewContext {
  index: Index;
  layout: Layout;
  links: { id: string; a: Pt; b: Pt; conduit: string }[];
  linkById: Map<string, { a: Pt; b: Pt }>;
  /**
   * Where each conduit's caption goes: on one of its own links, at the spot the layout names
   * (the middle of the first link in content order when it names none), so the caption always
   * sits on a line the conduit really has. `link` is that link's id.
   */
  conduitMarks: { id: string; label: string; x: number; y: number; link: string }[];
  /** Every text box on the map a defense glyph must keep off: node labels and conduit captions. */
  labelBoxes: LabelBox[];
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
    const spot = layout.conduitSpots[conduit.id];
    const first =
      (spot && links.find((l) => l.id === spot.link && l.conduit === conduit.id)) ||
      links.find((l) => l.conduit === conduit.id);
    if (first === undefined) continue;
    // Along the link at the layout's fraction, or in the middle when the layout names no spot.
    const at = spot !== undefined && first.id === spot.link ? spot.at : 0.5;
    conduitMarks.push({
      id: conduit.id,
      label: layout.conduits[conduit.id] ?? conduit.name,
      x: first.a.x + (first.b.x - first.a.x) * at,
      y: first.a.y + (first.b.y - first.a.y) * at,
      link: first.id,
    });
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

  const linkById = new Map<string, { a: Pt; b: Pt }>();
  for (const l of links) linkById.set(l.id, l);

  return {
    index,
    layout,
    links,
    linkById,
    conduitMarks,
    labelBoxes: [
      ...Object.values(layout.nodes).map((n) => nodeLabelBox(n.label, n.x, n.y)),
      ...conduitMarks.map(conduitLabelBox),
    ],
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

/** How far above a conduit caption's anchor its top edge sits, in map units (see labels.ts). */
export const CONDUIT_LABEL_DY = -7;

/**
 * The box a conduit caption covers, in map units. The numbers are the caption's style in
 * style.css (`.lbl-conduit`): 9 px monospace with 0.06em letter-spacing, so each character
 * takes about 6.2 px (0.6 x 9 + 0.06 x 9), drawn at one CSS pixel per map unit, centred on
 * x (translateX(-50%)) with its top at y + CONDUIT_LABEL_DY.
 */
export function conduitLabelBox(mark: { label: string; x: number; y: number }): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const width = mark.label.length * 6.2;
  const top = mark.y + CONDUIT_LABEL_DY;
  return { x0: mark.x - width / 2, y0: top, x1: mark.x + width / 2, y1: top + 9 };
}

/** How far below a node its label sits, in map units; labels.ts places the label with it. */
export const NODE_LABEL_DY = 15;

/**
 * The box a node label covers, in map units. The numbers are its style in style.css
 * (`.lbl-node`): 10.5 px monospace without letter-spacing, so each character takes about
 * 6.3 px (0.6 x 10.5), one line 10.5 px high, drawn at one CSS pixel per map unit, centred
 * on x (translateX(-50%)) with its top at y + NODE_LABEL_DY.
 */
export function nodeLabelBox(
  label: string,
  x: number,
  y: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const width = label.length * 6.3;
  const top = y + NODE_LABEL_DY;
  return { x0: x - width / 2, y0: top, x1: x + width / 2, y1: top + 10.5 };
}

const DEFENSE_GLYPH_RADIUS = 7;
/** Defense glyphs stay this far from a link's middle, where its conduit caption sits. */
const LABEL_CLEARANCE = 40;
/** Further glyphs on one link follow at this spacing: twice the radius plus 6. */
const DEFENSE_STACK_STEP = 20;
/** A glyph keeps this far from the end of its link, so it never sits on a machine. */
const LINK_END_MARGIN = 12;

/** How many slots of the alternating sequence are tried before the scan along the link starts. */
const MAX_GLYPH_SLOTS = 16;
/** The scan along a link tries a glyph position every this many map units. */
const SCAN_STEP = 4;
/** Extra room kept between a glyph disc and any label box. */
const LABEL_MARGIN = 2;

/** Whether a glyph at this point covers no label box and sits clear of every glyph already placed. */
function glyphFits(at: Pt, boxes: readonly LabelBox[], placed: readonly DiscInstance[]): boolean {
  const reach = DEFENSE_GLYPH_RADIUS + LABEL_MARGIN;
  for (const box of boxes) {
    const nx = Math.min(box.x1, Math.max(box.x0, at.x));
    const ny = Math.min(box.y1, Math.max(box.y0, at.y));
    if (Math.hypot(at.x - nx, at.y - ny) <= reach) return false;
  }
  const apart = 2 * DEFENSE_GLYPH_RADIUS + 4;
  return placed.every((g) => Math.hypot(at.x - g.x, at.y - g.y) >= apart);
}

/**
 * Where on a link of this length a glyph may sit, measured from its middle, most wanted first:
 * the alternating slots (towards b first, LABEL_CLEARANCE out, then every DEFENSE_STACK_STEP),
 * then every position the end margin allows, nearest the middle first. A short link clamps
 * several slots to the same place, so duplicates are dropped.
 */
function alongCandidates(len: number): number[] {
  const reach = Math.max(0, len / 2 - LINK_END_MARGIN);
  const out: number[] = [];
  const add = (along: number): void => {
    if (!out.includes(along)) out.push(along);
  };
  for (let slot = 0; slot < MAX_GLYPH_SLOTS; slot++) {
    const side = slot % 2 === 0 ? 1 : -1;
    const wanted = LABEL_CLEARANCE + Math.floor(slot / 2) * DEFENSE_STACK_STEP;
    add(side * Math.min(wanted, reach));
  }
  for (let d = 0; d <= reach; d += SCAN_STEP) {
    add(d);
    add(-d);
  }
  return out;
}

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
    const used = stacked.get(defense.link) ?? 0;
    stacked.set(defense.link, used + 1);
    // The first position that covers no label and no glyph already drawn. When the link has
    // none, the plain next slot stays (a test proves the real map never needs that).
    const middle = { x: (link.a.x + link.b.x) / 2, y: (link.a.y + link.b.y) / 2 };
    const pointAlong = (along: number): Pt => ({
      x: middle.x + ux * along,
      y: middle.y + uy * along,
    });
    const candidates = alongCandidates(len);
    const plain = candidates[Math.min(used, candidates.length - 1)] ?? 0;
    let at = pointAlong(plain);
    for (const along of candidates) {
      const candidate = pointAlong(along);
      if (glyphFits(candidate, ctx.labelBoxes, glyphs)) {
        at = candidate;
        break;
      }
    }
    const { x, y } = at;
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

const VIEW_SEVERITY: Record<ViewState, number> = { ok: 0, spoofed: 1, frozen: 2, blank: 3 };

/** The machines whose screens are the operators' picture of the line. */
const SUPERVISORY_KINDS: readonly NodeKind[] = ["hmi", "scada-server"];

/**
 * The state of the operators' feed: the worst view state among the supervisory machines.
 * Read off the world every time; nothing about it is stored anywhere else.
 */
export function reportingState(world: World): ViewState {
  let worst: ViewState = "ok";
  for (const node of world.nodes) {
    if (!SUPERVISORY_KINDS.includes(node.kind)) continue;
    if (VIEW_SEVERITY[node.view] > VIEW_SEVERITY[worst]) worst = node.view;
  }
  return worst;
}

/** What the drawn trains and sections are read from. */
interface Picture {
  occupancy: Uint8Array;
  trains: readonly TrainState[];
  /** True when the trains stand where an earlier snapshot left them: no interpolation, drawn dim. */
  stale: boolean;
  /** True when the feed says nothing at all: sections are drawn unlit. */
  unknown: boolean;
}

/**
 * Picks the picture to draw. Ground truth, and an operator view with a healthy feed, read
 * the world. A spoofed feed shows an all-clear with no trains; a frozen one shows the last
 * good snapshot, dimmed; a blank one (or a frozen one with no snapshot to show) shows
 * nothing. The interlocking and its signals are not part of this: they read their own
 * protected inputs, so signals and set routes are drawn from the world in every mode.
 */
function pictureOf(
  world: World,
  graph: Index["rail"]["graph"],
  mode: ViewMode,
  reporting: ViewState,
  lastGood: World | undefined,
): Picture {
  if (mode === "ground-truth" || reporting === "ok") {
    return {
      occupancy: computeOccupancy(world, graph),
      trains: world.trains,
      stale: false,
      unknown: false,
    };
  }
  if (reporting === "spoofed") {
    return {
      occupancy: new Uint8Array(graph.sections.length).fill(FREE),
      trains: [],
      stale: false,
      unknown: false,
    };
  }
  if (reporting === "frozen" && lastGood !== undefined && lastGood.tick <= world.tick) {
    return {
      occupancy: computeOccupancy(lastGood, graph),
      trains: lastGood.trains,
      stale: true,
      unknown: false,
    };
  }
  return {
    occupancy: new Uint8Array(graph.sections.length),
    trains: [],
    stale: false,
    unknown: true,
  };
}

/** A lit line over each link an alert has just touched, in the detection hue. */
function alertLines(ctx: ViewContext, alerts: readonly AlertLevel[]): LineInstance[] {
  const out: LineInstance[] = [];
  for (const alert of alerts) {
    const at = ctx.linkById.get(alert.link);
    if (at === undefined || alert.level <= 0) continue;
    const level = Math.min(1, alert.level);
    out.push({
      x0: at.a.x,
      y0: at.a.y,
      x1: at.b.x,
      y1: at.b.y,
      width: 3 + 3 * level,
      glow: 12 * level,
      dash: 0,
      color: rgba(ALERT_COLORS.detection, 0.2 + 0.8 * level),
    });
  }
  return out;
}

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

  const mode = opts.mode ?? "ground-truth";
  const reporting = reportingState(world);
  const picture = pictureOf(world, graph, mode, reporting, opts.lastGood);
  const { occupancy } = picture;
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
    const color = picture.unknown
      ? rgba(NEUTRAL.link, 1)
      : state === OCCUPIED
        ? rgba(NEUTRAL.trackOccupied, picture.stale ? 0.55 : 1)
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
  for (const train of world.trains) if (train.speedDmPerTick === 0) standing++;
  for (const train of picture.trains) {
    // A frozen console does not move: its trains are drawn where the snapshot left them.
    const before = picture.stale ? undefined : prevById.get(train.id);
    const posDm = before ? before.posDm + (train.posDm - before.posDm) * alpha : train.posDm;
    const drawn = trainLine(ctx, train, posDm);
    if (!drawn) continue;
    trains.push(picture.stale ? { ...drawn, glow: 0, color: rgba(NEUTRAL.train, 0.5) } : drawn);
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
    alerts: alertLines(ctx, opts.alerts ?? []),
    mode,
    reporting,
    trainsShown: trains.length,
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
