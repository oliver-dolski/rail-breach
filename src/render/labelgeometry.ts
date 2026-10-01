import type { Layout, Pt, ZoneBox } from "../content/layout";
import { CONDUIT_LABEL_DY, NODE_LABEL_DY } from "./view";

/**
 * Where every text label of the map really lands on screen, so a test (and anyone placing a
 * label) can tell when two labels, or a label and a zone border, collide.
 *
 * The labels are DOM text laid over the canvas (ui/labels.ts), and their size is set in CSS
 * pixels with a floor: `max(floor, u * size)`, where u is CSS pixels per map unit. On a small
 * canvas the floor wins, the text stops shrinking with the map, and in map units it gets
 * bigger. A box is therefore computed for a given u, and a layout is only clear when it is
 * clear at every u the page can show.
 */

/** One label style, as written in style.css (`.lbl-*`). */
export interface LabelStyle {
  /** Font size is max(floor, u * size) CSS pixels. */
  size: number;
  floor: number;
  /** Extra space after each character, in em. */
  spacing: number;
}

/** The four label styles. A test reads style.css and fails if these numbers drift from it. */
export const LABEL_STYLES = {
  zone: { size: 10, floor: 8, spacing: 0.12 },
  node: { size: 10.5, floor: 8, spacing: 0 },
  station: { size: 12, floor: 9, spacing: 0.04 },
  conduit: { size: 9, floor: 7, spacing: 0.06 },
} as const satisfies Record<string, LabelStyle>;

/** The widest a monospace character is, in em: the usual 0.6 of Courier and Liberation Mono. */
const CHAR_EM = 0.6;

/** Offsets in map units from a label's anchor to its top edge, as ui/labels.ts places it (node and conduit ones live in view.ts). */
export const ZONE_LABEL_DX = 8;
export const ZONE_LABEL_DY = 9;
export const STATION_LABEL_DY = 0;

/** Room kept around every label and every border line, in CSS pixels. */
export const LABEL_PAD_PX = 1.5;
/** Width of a zone border line in map units, as view.ts draws it. */
const ZONE_LINE_WIDTH = 1.4;

export type LabelKind = keyof typeof LABEL_STYLES;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedLabel {
  kind: LabelKind;
  /** Node id, zone id, conduit id, or the station name. */
  id: string;
  box: Box;
}

/** CSS pixels per map unit when the map fills a canvas of this size in CSS pixels. */
export function cssScale(canvasW: number, canvasH: number, layout: Layout): number {
  return Math.min(canvasW / layout.width, canvasH / layout.height);
}

/**
 * The box of a label in map units at scale u, padded by LABEL_PAD_PX on every side.
 * `centred` labels are centred on x (translateX(-50%)); the others start at x.
 */
export function labelBox(
  kind: LabelKind,
  text: string,
  at: Pt,
  top: number,
  centred: boolean,
  u: number,
): Box {
  const style: LabelStyle = LABEL_STYLES[kind];
  const font = Math.max(style.floor, u * style.size);
  const width = text.length * font * (CHAR_EM + style.spacing);
  const pad = LABEL_PAD_PX / u;
  const w = width / u;
  const x0 = centred ? at.x - w / 2 : at.x;
  return { x0: x0 - pad, y0: top - pad, x1: x0 + w + pad, y1: top + font / u + pad };
}

/** The conduit captions the map shows: id, text and anchor (on one of the conduit's links). */
export interface ConduitMark {
  id: string;
  label: string;
  x: number;
  y: number;
}

/** Every label of the map placed at scale u: zones, nodes, stations and conduit captions. */
export function placeLabels(
  layout: Layout,
  marks: readonly ConduitMark[],
  u: number,
): PlacedLabel[] {
  const out: PlacedLabel[] = [];
  for (const z of layout.zones) {
    const at = { x: z.x + ZONE_LABEL_DX, y: z.y + ZONE_LABEL_DY };
    out.push({ kind: "zone", id: z.id, box: labelBox("zone", z.label, at, at.y, false, u) });
  }
  for (const [id, n] of Object.entries(layout.nodes)) {
    out.push({ kind: "node", id, box: labelBox("node", n.label, n, n.y + NODE_LABEL_DY, true, u) });
  }
  for (const s of layout.stations) {
    out.push({
      kind: "station",
      id: s.name,
      box: labelBox("station", s.name, s, s.y + STATION_LABEL_DY, true, u),
    });
  }
  for (const m of marks) {
    out.push({
      kind: "conduit",
      id: m.id,
      box: labelBox("conduit", m.label, m, m.y + CONDUIT_LABEL_DY, true, u),
    });
  }
  return out;
}

/** Whether two boxes share any area. */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** The four sides of a zone, each as a thin box as wide as the drawn line plus the label padding. */
export function zoneBorders(zone: ZoneBox, u: number): Box[] {
  const t = ZONE_LINE_WIDTH / 2 + LABEL_PAD_PX / u;
  const { x, y, w, h } = zone;
  return [
    { x0: x - t, y0: y - t, x1: x + w + t, y1: y + t },
    { x0: x - t, y0: y + h - t, x1: x + w + t, y1: y + h + t },
    { x0: x - t, y0: y - t, x1: x + t, y1: y + h + t },
    { x0: x + w - t, y0: y - t, x1: x + w + t, y1: y + h + t },
  ];
}

/** The biggest a node glyph is drawn, in map units of radius (view.ts radiusOf). */
const NODE_GLYPH_RADIUS = 10;
/** Half the width of a track line in map units, with room to spare. */
const TRACK_HALF_WIDTH = 3;

/** Whether a box reaches a disc: the box point nearest its centre is within the radius. */
function boxTouchesDisc(box: Box, c: Pt, radius: number): boolean {
  const nx = Math.min(box.x1, Math.max(box.x0, c.x));
  const ny = Math.min(box.y1, Math.max(box.y0, c.y));
  return Math.hypot(c.x - nx, c.y - ny) < radius;
}

/** A thin box round a straight track segment (the tracks of the layout are all straight pieces). */
function segmentBox(a: Pt, b: Pt, half: number): Box {
  return {
    x0: Math.min(a.x, b.x) - half,
    y0: Math.min(a.y, b.y) - half,
    x1: Math.max(a.x, b.x) + half,
    y1: Math.max(a.y, b.y) + half,
  };
}

/**
 * Whether a box meets a track line. A slanted segment is cut into short pieces so its bounding
 * box does not claim the empty corner.
 */
function boxMeetsTrack(box: Box, a: Pt, b: Pt, half: number): boolean {
  const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let k = 0; k < pieces; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces };
    const q = {
      x: a.x + ((b.x - a.x) * (k + 1)) / pieces,
      y: a.y + ((b.y - a.y) * (k + 1)) / pieces,
    };
    if (boxesOverlap(box, segmentBox(p, q, half))) return true;
  }
  return false;
}

/**
 * Every collision at scale u:
 *  - two labels sharing area;
 *  - a label on a zone border line;
 *  - a conduit caption or a station name on a node glyph, or a node label on another node's glyph;
 *  - a station name on a track line.
 */
export function labelCollisions(
  layout: Layout,
  marks: readonly ConduitMark[],
  u: number,
): string[] {
  const labels = placeLabels(layout, marks, u);
  const found: string[] = [];
  const glyphReach = NODE_GLYPH_RADIUS + LABEL_PAD_PX / u;
  const trackHalf = TRACK_HALF_WIDTH + LABEL_PAD_PX / u;
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    if (!a) continue;
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j];
      if (b && boxesOverlap(a.box, b.box)) found.push(`${a.kind} ${a.id} and ${b.kind} ${b.id}`);
    }
    for (const zone of layout.zones) {
      if (zoneBorders(zone, u).some((side) => boxesOverlap(a.box, side))) {
        found.push(`${a.kind} ${a.id} and the border of ${zone.id}`);
      }
    }
    if (a.kind === "node" || a.kind === "conduit" || a.kind === "station") {
      for (const [id, n] of Object.entries(layout.nodes)) {
        if (a.kind === "node" && a.id === id) continue;
        if (boxTouchesDisc(a.box, n, glyphReach))
          found.push(`${a.kind} ${a.id} and the glyph of ${id}`);
      }
    }
    if (a.kind === "station") {
      for (const [id, line] of Object.entries(layout.blocks)) {
        for (let k = 1; k < line.length; k++) {
          const p = line[k - 1];
          const q = line[k];
          if (p && q && boxMeetsTrack(a.box, p, q, trackHalf)) {
            found.push(`${a.kind} ${a.id} and the track ${id}`);
            break;
          }
        }
      }
    }
  }
  return found;
}
