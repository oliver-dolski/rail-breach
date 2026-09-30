import type { Pt } from "../content/layout";

/** A polyline with cumulative lengths, so a fraction of its length maps to a point. */
export interface Polyline {
  pts: readonly Pt[];
  /** cum[i] is the distance from the first point to pts[i]. */
  cum: readonly number[];
  length: number;
}

export function polyline(pts: readonly Pt[]): Polyline {
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
    cum.push(total);
  }
  return { pts, cum, length: total };
}

export interface OnLine extends Pt {
  /** Unit direction of the segment the point lies on. */
  dx: number;
  dy: number;
}

/** The point at fraction f (0..1, clamped) of the length of the polyline. */
export function pointAt(line: Polyline, f: number): OnLine {
  const first = line.pts[0] ?? { x: 0, y: 0 };
  if (line.pts.length < 2 || line.length === 0) return { x: first.x, y: first.y, dx: 1, dy: 0 };
  const dist = Math.min(1, Math.max(0, f)) * line.length;
  let i = 1;
  while (i < line.pts.length - 1 && (line.cum[i] ?? 0) < dist) i++;
  const a = line.pts[i - 1] ?? first;
  const b = line.pts[i] ?? first;
  const segStart = line.cum[i - 1] ?? 0;
  const segLen = Math.max((line.cum[i] ?? 0) - segStart, 1e-9);
  const t = Math.min(1, Math.max(0, (dist - segStart) / segLen));
  const dx = (b.x - a.x) / segLen;
  const dy = (b.y - a.y) / segLen;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx, dy };
}

export interface Fit {
  /** Device pixels per map unit. */
  scale: number;
  /** Letterbox offset in device pixels. */
  ox: number;
  oy: number;
}

/** Fits the map sheet into a canvas, centred, without distortion. */
export function fitMap(canvasW: number, canvasH: number, mapW: number, mapH: number): Fit {
  const scale = Math.max(1e-6, Math.min(canvasW / mapW, canvasH / mapH));
  return { scale, ox: (canvasW - mapW * scale) / 2, oy: (canvasH - mapH * scale) / 2 };
}

/** The map-to-clip transform the shaders take as `uView`: [sx, sy, ox, oy]. */
export function viewUniform(
  fit: Fit,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] {
  return [
    (2 * fit.scale) / canvasW,
    (-2 * fit.scale) / canvasH,
    (2 * fit.ox) / canvasW - 1,
    1 - (2 * fit.oy) / canvasH,
  ];
}
