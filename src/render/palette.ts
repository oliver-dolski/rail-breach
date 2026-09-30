/**
 * Colours of the dispatcher console. Two hue families that never overlap:
 *
 *  SIGNAL_HUES  red, amber, green. Used for signal lamps and for nothing that
 *               an intruder or a detector does, so a signal at danger is never
 *               mistaken for an alert.
 *  ALERT_HUES   magenta, violet, blue, cyan. Attacker traffic, compromised,
 *               lost and degraded nodes, detections.
 *
 * Hues are degrees on the HSL wheel. Everything else on the map is a
 * desaturated neutral that carries no hue at all.
 */

export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

export const SIGNAL_HUES = { stop: 4, caution: 40, proceed: 140 } as const;

export const ALERT_HUES = { attacker: 318, impact: 268, degraded: 222, detection: 186 } as const;

/** Hue, saturation and lightness (degrees, 0..1, 0..1) to linear-enough sRGB in 0..1. */
export function hsl(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/** Hue of an sRGB colour in degrees, or null when it is (almost) grey. */
export function hueOf(rgb: Rgb): number | null {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Smallest angle between two hues on the wheel. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export const SIGNAL_COLORS = {
  stop: hsl(SIGNAL_HUES.stop, 0.92, 0.56),
  caution: hsl(SIGNAL_HUES.caution, 0.95, 0.56),
  proceed: hsl(SIGNAL_HUES.proceed, 0.78, 0.5),
} as const;

export const ALERT_COLORS = {
  attacker: hsl(ALERT_HUES.attacker, 0.92, 0.62),
  impact: hsl(ALERT_HUES.impact, 0.85, 0.68),
  degraded: hsl(ALERT_HUES.degraded, 0.85, 0.66),
  detection: hsl(ALERT_HUES.detection, 0.9, 0.58),
} as const;

/** Greys with a faint cool tint: saturation stays below the level hueOf reads as a hue. */
const grey = (l: number, tint = 0.05): Rgb => hsl(215, tint, l);

export const NEUTRAL = {
  background: [0.027, 0.04, 0.055] as Rgb,
  zone: grey(0.36),
  zoneLabel: grey(0.56),
  link: grey(0.3),
  track: grey(0.42),
  trackOccupied: grey(0.72, 0.06),
  node: grey(0.78),
  nodeLabel: grey(0.66),
  train: grey(0.96, 0.03),
  ambient: grey(0.62),
  lampDark: grey(0.22),
} as const;

/** What a node looks like, told by both its colour and its shape. */
export type NodeVisualState = "normal" | "compromised" | "degraded" | "lost";

/** Shape ids shared with disc.glsl. */
export const SHAPE = { disc: 0, ring: 1, diamond: 2, triangle: 3, cross: 4, lamp: 5 } as const;
export type ShapeName = keyof typeof SHAPE;

export interface NodeStyle {
  shape: ShapeName;
  color: Rgb;
}

export const NODE_STYLES: Record<NodeVisualState, NodeStyle> = {
  normal: { shape: "ring", color: NEUTRAL.node },
  compromised: { shape: "diamond", color: ALERT_COLORS.attacker },
  degraded: { shape: "triangle", color: ALERT_COLORS.degraded },
  lost: { shape: "cross", color: ALERT_COLORS.impact },
};

/** A colour as a CSS value, for the few DOM elements that share the map's palette. */
export function cssColor(rgb: Rgb): string {
  const c = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(rgb[0])} ${c(rgb[1])} ${c(rgb[2])})`;
}
