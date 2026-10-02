export const G3_MEAN_MAX: number;
export const G3_P95_MAX: number;
export const G4_MAX_DELTA: number;
export const G4_GLOW_CLEARANCE_PX: number;
export const G4_BRIGHT: number;
export const G4_DOT_CLEARANCE_PX: number;
export const G4_LABEL_MARGIN_PX: number;
export const G4_BORDER_CLEARANCE_UNITS: number;
export const G4_TINT_CHROMA: number;
export const G4_WINDOW_RADIUS: number;
export const G4_MIN_SAMPLES: number;
export const OLD_VIGNETTE: number;
export const NEW_VIGNETTE: number;
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export function relativeLuminance(r: number, g: number, b: number): number;
export function labelBackdropStats(
  pixels: Uint8Array,
  width: number,
  boxes: PixelBox[],
): { mean: number; p95: number; count: number };
export function vignetteFactor(
  depth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number;
export function boxMask(boxes: PixelBox[], width: number, height: number): Uint8Array;
export function brightClearance(
  images: Uint8Array[],
  width: number,
  height: number,
  threshold: number,
  radius: number,
  ignores?: (Uint8Array | undefined)[],
): Uint8Array;
export function compensatedMean(
  pixels: Uint8Array,
  width: number,
  canvas: PixelBox,
  depth: number,
  x: number,
  y: number,
  radius?: number,
): [number, number, number];
export interface ZoneBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export function zoneBorderDistance(zones: ZoneBox[], mx: number, my: number): number;
export function zoneAt(zones: ZoneBox[], mx: number, my: number): ZoneBox | undefined;
export function isTinted(shifts: number[], chroma?: number): boolean;
export function boardDiff(
  oldPixels: Uint8Array,
  newPixels: Uint8Array,
  samples: { x: number; y: number }[],
  options: {
    width: number;
    canvas: PixelBox;
    oldDepth?: number;
    newDepth?: number;
    radius?: number;
  },
): {
  compared: number;
  maxDelta: number;
  median: number;
  p99: number;
  worst: { x: number; y: number; channel: number; delta: number; was: number; now: number }[];
};
export function boardSamples(
  layout: {
    width: number;
    height: number;
    blocks: Record<string, { x: number; y: number }[]>;
    nodes: Record<string, { x: number; y: number }>;
  },
  links: { a: string; b: string }[],
  canvasBox: PixelBox,
): { samples: { x: number; y: number; mx: number; my: number }[]; scale: number };
export function checkStills(options?: {
  workDir?: string;
  baselineDir?: string;
}): Promise<{ lines: string[]; failures: string[] }>;
