import type { Fit } from "../geometry";

/**
 * The intro as a pure function of time. It says where the layers hang, how far they are tilted,
 * what fades in and what fades out, and builds the one matrix per layer that carries a point of
 * the flat board to where that layer shows it. Nothing here reads a clock or touches GL: the
 * renderer feeds it the intro's elapsed milliseconds and draws what comes back.
 *
 * The board is drawn once per layer through its matrix. At the end of the fold the tilt, the
 * separation and the shift are exactly 0 and the scale exactly 1, so every matrix is the live 2D
 * fit and the fold lands on the flat board without a pop.
 */

export const INTRO_MS = 4000;
/** The layers fade in from the ground until here. */
export const FADE_IN_END_MS = 600;
/** The packet falls through the layers until here. */
export const FALL_END_MS = 2400;
/** The fold ends here: the layers are the flat board. */
export const FOLD_END_MS = 3600;
/** The board takes over, the labels fade in, from FOLD_END_MS to INTRO_MS. */
export const CROSSFADE_MS = INTRO_MS - FOLD_END_MS;
export const LAYER_COUNT = 5;
/** Each layer flares once, inside its own slot: five slots end at FALL_END_MS - 360. */
export const FLARE_SLOT_MS = 360;

const DEG = Math.PI / 180;
/** The tilt the layers hang at before the fold, and how far it drifts (at most 1.5 degrees). */
export const START_TILT = 56 * DEG;
export const TILT_DRIFT = 1.2 * DEG;
/** Where the stack sits left of the middle at the start, as a share of the canvas width. */
export const START_SHIFT = 0;
/** Distance of the eye from the sheet, in canvas heights: the perspective is mild. */
export const FOCAL_HEIGHTS = 2.4;
/** The gap between two packed layers on the sheet, in map units. */
export const STACK_GAP = 14;
/** Distance between two layers along the plane normal, in map units. */
export const STACK_DEPTH = 0;

export interface IntroPose {
  /** Tilt about the horizontal axis through the sheet centre, radians; 0 is the flat board. */
  theta: number;
  /** 1 while the layers are pulled apart, easing to 0. */
  separation: number;
  /** Global scale of the stack, easing to 1. */
  scale: number;
  /** The fold eased (cubic in-out): 0 before the fold, 1 after it. */
  foldProgress: number;
  /** Layers fading in from the ground over the first 600 ms. */
  fadeIn: number;
  /** The level names: in with the layers, out within the first third of the fold. */
  namesAlpha: number;
  /** The panels that mark each layer as a plate: out during the first part of the fold. */
  plateAlpha: number;
  /** Conduits, alerts and defense glyphs: in over the last 40 percent of the fold. */
  bridgesAlpha: number;
  /** Ambient traffic: in only once the layers have all but settled. */
  ambientAlpha: number;
  /** The DOM map labels: 0 until the fold ends, then linear to 1. */
  labelsAlpha: number;
  /** The stack's shift to the side, in canvas widths; 0 once the fold ends. */
  shiftX: number;
  /** How brightly each layer's border flares right now. */
  flares: readonly number[];
}

export interface IntroCanvas {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where one layer hangs: shifts in map units, scaled by the separation. */
export interface StackSlot {
  /** Along the sheet's vertical axis, before the tilt. */
  dv: number;
  /** Along the sheet's normal, toward the viewer. */
  dz: number;
}

export interface IntroSheet {
  width: number;
  height: number;
  stack: readonly StackSlot[];
}

type Mat4 = number[];

const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};
const scaling = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
};
/** Rotation about the x axis, column-major: y goes toward +z for a positive angle. */
const rotationX = (a: number): Mat4 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
};
/** a * b, column-major: b is applied first. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Cubic in-out: exactly 0 at 0 and exactly 1 at 1. */
export function easeInOutCubic(x: number): number {
  const v = clamp01(x);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

const smooth = (x: number): number => {
  const v = clamp01(x);
  return v * v * (3 - 2 * v);
};

/** The share of the fold done at tMs, linear, 0 to 1. */
export function foldTime(tMs: number): number {
  return clamp01((tMs - FALL_END_MS) / (FOLD_END_MS - FALL_END_MS));
}

/** The scale the stack starts at: small enough that the tilted stack fits the canvas. */
export function startScale(_aspect: number): number {
  return 0.8;
}

const NO_FLARES: readonly number[] = Array.from({ length: LAYER_COUNT }, () => 0);

export function introPose(tMs: number, aspect: number): IntroPose {
  const t = Math.min(INTRO_MS, Math.max(0, tMs));
  const f = foldTime(t);
  const e = easeInOutCubic(f);
  // The drift is one slow hump that is back at 0 exactly when the fold starts.
  const drift = TILT_DRIFT * Math.sin((Math.PI * Math.min(t, FALL_END_MS)) / FALL_END_MS);
  const s0 = startScale(aspect);
  const fadeIn = smooth(t / FADE_IN_END_MS);
  return {
    theta: (START_TILT + drift) * (1 - e),
    separation: 1 - e,
    scale: s0 + (1 - s0) * e,
    foldProgress: e,
    fadeIn,
    namesAlpha: fadeIn * (1 - clamp01(f * 3)),
    plateAlpha: fadeIn * (1 - smooth(f / 0.6)),
    bridgesAlpha: clamp01((f - 0.6) / 0.4),
    ambientAlpha: clamp01((e - 0.92) / 0.08),
    labelsAlpha: clamp01((t - FOLD_END_MS) / CROSSFADE_MS),
    shiftX: START_SHIFT * (1 - e),
    flares: NO_FLARES,
  };
}

/**
 * Packs the layers' plates one under the other on the sheet, top layer first, and says how far
 * each has to move to its place and how far toward the viewer it hangs. One plate hangs where it is.
 */
export function introSheet(
  plates: readonly Rect[],
  size: { width: number; height: number },
): IntroSheet {
  const n = plates.length;
  let total = (n - 1) * STACK_GAP;
  for (const p of plates) total += p.h;
  let top = size.height / 2 - total / 2;
  const stack = plates.map((p, i) => {
    const packedCentre = top + p.h / 2;
    top += p.h + STACK_GAP;
    return { dv: packedCentre - (p.y + p.h / 2), dz: ((n - 1) / 2 - i) * STACK_DEPTH };
  });
  return { width: size.width, height: size.height, stack };
}

/**
 * The matrix that takes a map point (x, y, 0) of this layer to clip space: the live 2D fit,
 * then the layer's place in the stack, the tilt about the sheet centre, the shift and a mild
 * perspective that leaves z = 0 alone (w is 1 there). The z row is 0: there is no depth buffer
 * and layers are painted back to front.
 */
export function layerMatrix(
  pose: IntroPose,
  layer: number,
  fit: Fit,
  canvas: IntroCanvas,
  sheet: IntroSheet,
): Float32Array {
  const k = fit.scale;
  const slot = sheet.stack[layer] ?? { dv: 0, dz: 0 };
  // Where the sheet centre sits, in pixels from the middle of the canvas.
  const cu = fit.ox + (sheet.width / 2) * k - canvas.width / 2;
  const cv = fit.oy + (sheet.height / 2) * k - canvas.height / 2;

  let m = translation(-sheet.width / 2, -sheet.height / 2, 0);
  m = multiply(scaling(k, k, k), m);
  m = multiply(translation(0, slot.dv * k * pose.separation, slot.dz * k * pose.separation), m);
  m = multiply(scaling(pose.scale, pose.scale, pose.scale), m);
  m = multiply(rotationX(pose.theta), m);
  m = multiply(translation(cu + pose.shiftX * canvas.width, cv, 0), m);

  const eye = FOCAL_HEIGHTS * canvas.height;
  const perspective = identity();
  perspective[11] = -1 / eye;
  m = multiply(perspective, m);

  const clip = identity();
  clip[0] = 2 / canvas.width;
  clip[5] = -2 / canvas.height;
  clip[10] = 0;
  return Float32Array.from(multiply(clip, m));
}

export interface Projected {
  /** Clip space after the divide by w. */
  x: number;
  y: number;
  w: number;
}

/** A map point through a layer matrix, divided by w. */
export function projectToClip(matrix: Float32Array, x: number, y: number): Projected {
  const cx = (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[12] ?? 0);
  const cy = (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[13] ?? 0);
  const w = (matrix[3] ?? 0) * x + (matrix[7] ?? 0) * y + (matrix[15] ?? 0);
  return { x: cx / w, y: cy / w, w };
}
