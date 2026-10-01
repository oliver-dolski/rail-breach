import { createPost, disposePost, type Post } from "./post";
import { createPrimitives, disposePrimitives, type Primitives } from "./primitives";
import type { RenderTier } from "./tier";

/** Device pixel ratio is capped: above 2 the extra pixels cost more than they show. */
export const MAX_DPR = 2;

export interface Webgl2Result {
  ok: boolean;
  gl?: WebGL2RenderingContext;
  /** Why WebGL2 is not usable, for the fallback message. */
  reason?: string;
}

/** The part of a canvas that detection needs, so it can be tested without a DOM. */
export interface ContextSource {
  getContext(id: "webgl2", options?: WebGLContextAttributes): unknown;
}

/**
 * Asks for a WebGL2 context and refuses software rendering: a context with a
 * major performance caveat would run the map at a crawl, and the static image
 * is the better answer.
 */
export function detectWebgl2(canvas: ContextSource): Webgl2Result {
  try {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
    });
    if (!gl) {
      return { ok: false, reason: "This browser did not provide a hardware WebGL2 context." };
    }
    return { ok: true, gl: gl as WebGL2RenderingContext };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, reason: `Creating the WebGL2 context failed: ${detail}` };
  }
}

export interface GlResources {
  prims: Primitives;
  /** The bloom chain; absent on the lite tier, which draws straight to the canvas. */
  post: Post | undefined;
  tier: RenderTier;
}

/**
 * Creates every GL resource for a tier. Called at start and again after a lost context is
 * restored. A failure frees what was made and throws, so the caller can try the next tier.
 */
export function initGL(gl: WebGL2RenderingContext, tier: RenderTier): GlResources {
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  const prims = createPrimitives(gl);
  if (tier === "lite") return { prims, post: undefined, tier };
  try {
    return { prims, post: createPost(gl, tier), tier };
  } catch (error) {
    disposePrimitives(gl, prims);
    throw error;
  }
}

/** Frees everything initGL made. */
export function disposeGL(gl: WebGL2RenderingContext, res: GlResources): void {
  disposePrimitives(gl, res.prims);
  if (res.post) disposePost(gl, res.post);
}

export interface CanvasSize {
  /** Backing store size in device pixels. */
  width: number;
  height: number;
  dpr: number;
}

/** Sizes the backing store to the element's CSS size at the capped device pixel ratio. */
export function fitCanvas(canvas: HTMLCanvasElement, devicePixelRatio: number): CanvasSize {
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), MAX_DPR);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height, dpr };
}

export interface ContextEvents {
  onLost(): void;
  onRestored(): void;
}

/**
 * Listens for context loss. preventDefault on the lost event is what allows the
 * browser to restore the context later.
 */
export function watchContext(canvas: HTMLCanvasElement, events: ContextEvents): () => void {
  const lost = (e: Event): void => {
    e.preventDefault();
    events.onLost();
  };
  const restored = (): void => events.onRestored();
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return () => {
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
}
