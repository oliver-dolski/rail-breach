/**
 * Render tiers and the numbers behind the glow. Pure: no twgl, nothing from src/core, so every
 * decision here can be tested in node with a stub context.
 *
 *  high      the scene is an RGBA16F target, three blur levels, a tone shoulder
 *  standard  RGBA8 targets, two blur levels: the look before the HDR pipeline
 *  lite      no bloom chain at all, only the glow each primitive draws for itself
 *
 * The tier only ever changes how a frame is drawn. It never reaches the simulation.
 */

export type RenderTier = "high" | "standard" | "lite";

/** Best first. A tier that fails to build hands over to the next one down. */
export const TIER_ORDER: readonly RenderTier[] = ["high", "standard", "lite"];

/** Glow radius to emissive gain: a primitive with glow radius g emits its core at 1 + min(0.06 g, 0.6). */
export const EMISSIVE_PER_GLOW = 0.06;
export const EMISSIVE_MAX = 0.6;
/** Below this the tone curve is the identity, so ordinary board colours are untouched by it. */
export const TONE_KNEE = 0.8;
export const VIGNETTE_DEPTH = 0.28;

export function emissiveGain(glow: number): number {
  if (!(glow > 0)) return 1;
  return 1 + Math.min(EMISSIVE_PER_GLOW * glow, EMISSIVE_MAX);
}

/** Identity up to the knee, then a tanh shoulder that approaches 1 and never reaches past it. */
export function toneShoulder(c: number, knee: number = TONE_KNEE): number {
  if (c <= knee) return c;
  const room = 1 - knee;
  return knee + room * Math.tanh((c - knee) / room);
}

export interface BloomSettings {
  /** Blur levels, 0 for none. */
  levels: 0 | 2 | 3;
  /** Whether the scene and the levels are half-float targets. */
  float: boolean;
  /** Bright pass smoothstep edges, on the target's own values. */
  threshold: readonly [number, number];
  /** Composite weight of each level; unused levels carry 0. */
  weights: readonly [number, number, number];
  strength: number;
  /** Tone shoulder knee; 1 turns the shoulder off (an 8-bit target already clips there). */
  knee: number;
  /** Separable blur rounds per level. */
  rounds: number;
}

export function bloomSettings(tier: RenderTier, reducedMotion: boolean): BloomSettings {
  if (tier === "high") {
    return {
      levels: 3,
      float: true,
      threshold: [0.8, 1.2],
      weights: [0.45, 0.35, 0.3],
      strength: reducedMotion ? 0.5 : 0.9,
      knee: TONE_KNEE,
      rounds: 1,
    };
  }
  if (tier === "standard") {
    return {
      levels: 2,
      float: false,
      threshold: [0.6, 1.0],
      weights: [0.6, 0.4, 0],
      strength: reducedMotion ? 0.5 : 0.8,
      knee: 1,
      rounds: 2,
    };
  }
  return {
    levels: 0,
    float: false,
    threshold: [0.6, 1.0],
    weights: [0, 0, 0],
    strength: 0,
    knee: 1,
    rounds: 0,
  };
}

/** The few WebGL2 calls the float-target probe makes, so a stub object can stand in for a context. */
export interface FloatProbe {
  readonly TEXTURE_2D: number;
  readonly RGBA: number;
  readonly RGBA16F: number;
  readonly HALF_FLOAT: number;
  readonly FRAMEBUFFER: number;
  readonly COLOR_ATTACHMENT0: number;
  readonly FRAMEBUFFER_COMPLETE: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  readonly NEAREST: number;
  getExtension(name: string): unknown;
  createTexture(): WebGLTexture | null;
  bindTexture(target: number, texture: WebGLTexture | null): void;
  texImage2D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null,
  ): void;
  texParameteri(target: number, pname: number, param: number): void;
  createFramebuffer(): WebGLFramebuffer | null;
  bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void;
  framebufferTexture2D(
    target: number,
    attachment: number,
    textarget: number,
    texture: WebGLTexture | null,
    level: number,
  ): void;
  checkFramebufferStatus(target: number): number;
  deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;
  deleteTexture(texture: WebGLTexture | null): void;
}

/** True when a 4x4 RGBA16F texture can be a complete colour attachment. Leaves no GL object behind. */
export function floatTargetComplete(gl: FloatProbe): boolean {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    if (!texture || !framebuffer) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}

/**
 * The best tier this GPU offers at boot: high needs a float colour-buffer extension and a
 * framebuffer that really completes with it (an extension string alone has lied before).
 */
export function chooseTier(gl: FloatProbe): RenderTier {
  const offered =
    gl.getExtension("EXT_color_buffer_float") ?? gl.getExtension("EXT_color_buffer_half_float");
  if (!offered) return "standard";
  return floatTargetComplete(gl) ? "high" : "standard";
}

/** The tiers from `start` down to lite, in order. */
export function tiersFrom(start: RenderTier): RenderTier[] {
  return TIER_ORDER.slice(TIER_ORDER.indexOf(start));
}

/**
 * Builds with the first tier that does not throw. When every tier throws the last error
 * goes up, which is the signal that the base pipeline itself is broken.
 */
export function firstWorking<T>(
  order: readonly RenderTier[],
  build: (tier: RenderTier) => T,
): { tier: RenderTier; value: T } {
  let last: unknown = new Error("no render tier to try");
  for (const tier of order) {
    try {
      return { tier, value: build(tier) };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
