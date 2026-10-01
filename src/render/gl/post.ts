import * as twgl from "twgl.js";
import postSource from "../shaders/post.glsl?raw";
import { compileProgram } from "./primitives";
import { type BloomSettings, VIGNETTE_DEPTH } from "./tier";

/**
 * Bloom as a chain of blur levels. The scene is rendered into a texture (RGBA16F on the high
 * tier, so lamps can be brighter than white), the bright parts are cut out, blurred at 1/2, 1/4
 * and 1/8 of the canvas, and the levels are added back while drawing to the canvas, with the tone
 * shoulder, the vignette and the dither. The standard tier is the same chain on RGBA8 with two
 * levels. The lite tier has no chain: the renderer draws straight to the canvas.
 */

export type PostTier = "high" | "standard";

/** One blur level: a ping and a pong target at the level's size. */
export interface BloomLevel {
  ping: twgl.FramebufferInfo;
  pong: twgl.FramebufferInfo;
  width: number;
  height: number;
}

export interface PostTargets {
  scene: twgl.FramebufferInfo;
  levels: BloomLevel[];
  width: number;
  height: number;
}

export interface Post {
  tier: PostTier;
  bright: twgl.ProgramInfo;
  down: twgl.ProgramInfo;
  blur: twgl.ProgramInfo;
  composite: twgl.ProgramInfo;
  /** An empty vertex array: the post shaders build their triangle from gl_VertexID. */
  vao: WebGLVertexArrayObject;
  targets: PostTargets | undefined;
}

/** Blur levels per tier, each at 1/2, 1/4, 1/8 of the canvas. */
const LEVELS: Record<PostTier, number> = { high: 3, standard: 2 };

const attachments = (gl: WebGL2RenderingContext, tier: PostTier): twgl.AttachmentOptions[] => [
  tier === "high"
    ? {
        internalFormat: gl.RGBA16F,
        format: gl.RGBA,
        type: gl.HALF_FLOAT,
        min: gl.LINEAR,
        mag: gl.LINEAR,
        wrap: gl.CLAMP_TO_EDGE,
      }
    : { format: gl.RGBA, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE },
];

export function createPost(gl: WebGL2RenderingContext, tier: PostTier): Post {
  // Rendering into a float texture needs the extension switched on for this context, and it has
  // to be asked again after a restored context.
  if (tier === "high") {
    gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("EXT_color_buffer_half_float");
  }
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("could not allocate a vertex array");
  const programs: twgl.ProgramInfo[] = [];
  try {
    const build = (pass: string): twgl.ProgramInfo => {
      const info = compileProgram(gl, postSource, [pass]);
      programs.push(info);
      return info;
    };
    return {
      tier,
      bright: build("PASS_BRIGHT"),
      down: build("PASS_DOWN"),
      blur: build("PASS_BLUR"),
      composite: build("PASS_COMPOSITE"),
      vao,
      targets: undefined,
    };
  } catch (error) {
    for (const p of programs) gl.deleteProgram(p.program);
    gl.deleteVertexArray(vao);
    throw error;
  }
}

function levelSize(width: number, height: number, level: number): [number, number] {
  return [Math.max(1, width >> (level + 1)), Math.max(1, height >> (level + 1))];
}

/** Throws unless the framebuffer is complete: this is what lets a tier fall through to the next. */
function assertComplete(
  gl: WebGL2RenderingContext,
  info: twgl.FramebufferInfo,
  what: string,
): void {
  twgl.bindFramebufferInfo(gl, info);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  twgl.bindFramebufferInfo(gl, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`${what} framebuffer is incomplete (0x${status.toString(16)})`);
  }
}

function deleteTarget(gl: WebGL2RenderingContext, info: twgl.FramebufferInfo): void {
  for (const a of info.attachments) gl.deleteTexture(a as WebGLTexture);
  gl.deleteFramebuffer(info.framebuffer);
}

function disposeTargets(gl: WebGL2RenderingContext, t: PostTargets): void {
  deleteTarget(gl, t.scene);
  for (const level of t.levels) {
    deleteTarget(gl, level.ping);
    deleteTarget(gl, level.pong);
  }
}

/** Frees every GL object the chain holds. Safe to call on a half-built chain. */
export function disposePost(gl: WebGL2RenderingContext, post: Post): void {
  if (post.targets) disposeTargets(gl, post.targets);
  post.targets = undefined;
  for (const p of [post.bright, post.down, post.blur, post.composite]) gl.deleteProgram(p.program);
  gl.deleteVertexArray(post.vao);
}

/**
 * (Re)creates the render targets for a canvas of this size in device pixels. Throws when the GPU
 * refuses one of them, after freeing what was made, so the caller can fall to the next tier.
 */
export function sizePost(
  gl: WebGL2RenderingContext,
  post: Post,
  width: number,
  height: number,
): void {
  const spec = attachments(gl, post.tier);
  const existing = post.targets;
  if (existing && existing.width === width && existing.height === height) return;
  if (existing) {
    twgl.resizeFramebufferInfo(gl, existing.scene, spec, width, height);
    existing.levels.forEach((level, i) => {
      const [w, h] = levelSize(width, height, i);
      twgl.resizeFramebufferInfo(gl, level.ping, spec, w, h);
      twgl.resizeFramebufferInfo(gl, level.pong, spec, w, h);
      level.width = w;
      level.height = h;
    });
    existing.width = width;
    existing.height = height;
    return;
  }

  const made: twgl.FramebufferInfo[] = [];
  const make = (w: number, h: number, what: string): twgl.FramebufferInfo => {
    const info = twgl.createFramebufferInfo(gl, spec, w, h);
    made.push(info);
    assertComplete(gl, info, what);
    return info;
  };
  try {
    const scene = make(width, height, "scene");
    const levels: BloomLevel[] = [];
    for (let i = 0; i < LEVELS[post.tier]; i++) {
      const [w, h] = levelSize(width, height, i);
      levels.push({
        ping: make(w, h, `bloom level ${i + 1} ping`),
        pong: make(w, h, `bloom level ${i + 1} pong`),
        width: w,
        height: h,
      });
    }
    post.targets = { scene, levels, width, height };
  } catch (error) {
    for (const info of made) deleteTarget(gl, info);
    throw error;
  }
}

function fullscreen(
  gl: WebGL2RenderingContext,
  post: Post,
  program: twgl.ProgramInfo,
  uniforms: Record<string, unknown>,
): void {
  gl.useProgram(program.program);
  twgl.setUniforms(program, uniforms);
  gl.bindVertexArray(post.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

function texOf(target: twgl.FramebufferInfo): WebGLTexture {
  const tex = target.attachments[0];
  if (!tex) throw new Error("render target has no colour attachment");
  return tex as WebGLTexture;
}

/**
 * Bright pass into level 1, a downsample and a blur per level, then the composite onto the canvas
 * framebuffer: scene plus the weighted levels, tone shoulder, vignette, dither.
 */
export function runBloom(gl: WebGL2RenderingContext, post: Post, settings: BloomSettings): void {
  const t = post.targets;
  if (!t || t.levels.length === 0) return;
  gl.disable(gl.BLEND);
  const levels = Math.min(settings.levels, t.levels.length);

  for (let i = 0; i < levels; i++) {
    const level = t.levels[i];
    if (!level) break;
    twgl.bindFramebufferInfo(gl, level.ping);
    if (i === 0) {
      fullscreen(gl, post, post.bright, { uTex: texOf(t.scene), uThreshold: settings.threshold });
    } else {
      const above = t.levels[i - 1];
      if (!above) break;
      fullscreen(gl, post, post.down, {
        uTex: texOf(above.ping),
        uTexel: [1 / above.width, 1 / above.height],
      });
    }
    for (let round = 0; round < settings.rounds; round++) {
      twgl.bindFramebufferInfo(gl, level.pong);
      fullscreen(gl, post, post.blur, {
        uTex: texOf(level.ping),
        uTexel: [1 / level.width, 1 / level.height],
        uDir: [1, 0],
      });
      twgl.bindFramebufferInfo(gl, level.ping);
      fullscreen(gl, post, post.blur, {
        uTex: texOf(level.pong),
        uTexel: [1 / level.width, 1 / level.height],
        uDir: [0, 1],
      });
    }
  }

  const first = t.levels[0];
  if (!first) return;
  const pingOf = (i: number): WebGLTexture => texOf((t.levels[i] ?? first).ping);
  twgl.bindFramebufferInfo(gl, null);
  gl.viewport(0, 0, t.width, t.height);
  fullscreen(gl, post, post.composite, {
    uTex: texOf(t.scene),
    uBloom1: pingOf(0),
    uBloom2: pingOf(1),
    uBloom3: pingOf(2),
    uWeights: settings.weights,
    uLevels: levels,
    uStrength: settings.strength,
    uKnee: settings.knee,
    uVignette: VIGNETTE_DEPTH,
  });
}
