import type { Pt } from "../../content/layout";
import type { DiscInstance, LineInstance, RenderView, ViewContext } from "../view";
import type { IntroLevel } from "./levels";
import { type IntroCanvas, type IntroPose, projectToClip } from "./pose";

/**
 * The things that run between layers, drawn in canvas pixels. A conduit joins two machines that
 * hang in different layers, so no single layer matrix can carry it. Each end is carried by the
 * matrix of its own layer and the line is drawn between the two results, so it stays joined to
 * both however far the layers are apart. A glyph that sits on a conduit is placed along the same
 * line. At the end of the fold the result is the live board in pixels.
 */
export interface ScreenBridges {
  links: LineInstance[];
  trail: LineInstance[];
  alerts: LineInstance[];
  arrows: LineInstance[];
  /** Defense glyphs, then any machine or halo that lay outside every zone. */
  discs: DiscInstance[];
}

interface Anchored {
  /** Where the map point lands, in canvas pixels. */
  x: number;
  y: number;
  /** Pixels one map unit is long along x and along y at that point. */
  ex: Pt;
  ey: Pt;
  scale: number;
}

export function bridgesToScreen(
  bridges: RenderView,
  ctx: ViewContext,
  levels: readonly IntroLevel[],
  matrices: readonly Float32Array[],
  canvas: IntroCanvas,
  pose: IntroPose,
): ScreenBridges {
  const levelOfZone = new Map<string, number>();
  for (const level of levels) for (const id of level.zoneIds) levelOfZone.set(id, level.index);
  const levelAt = (x: number, y: number): number | undefined => {
    for (const z of ctx.zoneBoxes) {
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return levelOfZone.get(z.id);
    }
    return undefined;
  };

  const pixel = (m: Float32Array, x: number, y: number): Pt => {
    const p = projectToClip(m, x, y);
    return { x: ((p.x + 1) / 2) * canvas.width, y: ((1 - p.y) / 2) * canvas.height };
  };

  /** A point that hangs in a layer: carried by that layer's matrix alone. */
  const inLayer = (m: Float32Array, x: number, y: number): Anchored => {
    const at = pixel(m, x, y);
    const px = pixel(m, x + 1, y);
    const py = pixel(m, x, y + 1);
    const ex = { x: px.x - at.x, y: px.y - at.y };
    const ey = { x: py.x - at.x, y: py.y - at.y };
    return {
      x: at.x,
      y: at.y,
      ex,
      ey,
      scale: (Math.hypot(ex.x, ex.y) + Math.hypot(ey.x, ey.y)) / 2,
    };
  };

  const conduits = ctx.links.filter((l) => l.conduit !== "");
  const fallback = matrices[0] as Float32Array;

  /** A point on or beside a conduit: placed along the line between its two ends. */
  const alongConduit = (x: number, y: number): Anchored => {
    let best = conduits[0];
    let bestT = 0;
    let bestD = Number.POSITIVE_INFINITY;
    let closest: Pt = { x, y };
    for (const link of conduits) {
      const dx = link.b.x - link.a.x;
      const dy = link.b.y - link.a.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.min(1, Math.max(0, ((x - link.a.x) * dx + (y - link.a.y) * dy) / len2));
      const c = { x: link.a.x + dx * t, y: link.a.y + dy * t };
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        best = link;
        bestT = t;
        bestD = d;
        closest = c;
      }
    }
    if (best === undefined) return inLayer(fallback, x, y);
    const ma = matrices[levelAt(best.a.x, best.a.y) ?? 0] ?? fallback;
    const mb = matrices[levelAt(best.b.x, best.b.y) ?? 0] ?? fallback;
    const a = inLayer(ma, best.a.x, best.a.y);
    const b = inLayer(mb, best.b.x, best.b.y);
    const near = bestT < 0.5 ? a : b;
    const ox = x - closest.x;
    const oy = y - closest.y;
    return {
      x: a.x + (b.x - a.x) * bestT + ox * near.ex.x + oy * near.ey.x,
      y: a.y + (b.y - a.y) * bestT + ox * near.ex.y + oy * near.ey.y,
      ex: near.ex,
      ey: near.ey,
      scale: a.scale + (b.scale - a.scale) * bestT,
    };
  };

  const attach = (x: number, y: number): Anchored => {
    const level = levelAt(x, y);
    const m = level === undefined ? undefined : matrices[level];
    return m === undefined ? alongConduit(x, y) : inLayer(m, x, y);
  };

  const fade = pose.bridgesAlpha;
  const line = (l: LineInstance): LineInstance => {
    const a = attach(l.x0, l.y0);
    const b = attach(l.x1, l.y1);
    const scale = (a.scale + b.scale) / 2;
    return {
      x0: a.x,
      y0: a.y,
      x1: b.x,
      y1: b.y,
      width: l.width * scale,
      glow: l.glow * scale,
      dash: l.dash * scale,
      color: [l.color[0], l.color[1], l.color[2], l.color[3] * fade],
    };
  };
  const disc = (d: DiscInstance): DiscInstance => {
    const a = attach(d.x, d.y);
    return {
      x: a.x,
      y: a.y,
      radius: d.radius * a.scale,
      shape: d.shape,
      glow: d.glow * a.scale,
      color: [d.color[0], d.color[1], d.color[2], d.color[3] * fade],
    };
  };

  return {
    links: bridges.links.map(line),
    trail: bridges.trail.map(line),
    alerts: bridges.alerts.map(line),
    arrows: bridges.defenseArrows.map(line),
    discs: [...bridges.defenses, ...bridges.nodes, ...bridges.halos].map(disc),
  };
}
