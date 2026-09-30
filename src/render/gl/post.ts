import * as twgl from "twgl.js";
import postSource from "../shaders/post.glsl?raw";
import { compileProgram } from "./primitives";

/**
 * Bloom at half resolution: the scene is rendered into a texture, bright parts
 * are blurred at half size, and the result is added back while drawing to the
 * canvas. Half size keeps the cost low on weak GPUs and widens the glow.
 */

export interface PostTargets {
  scene: twgl.FramebufferInfo;
  ping: twgl.FramebufferInfo;
  pong: twgl.FramebufferInfo;
  width: number;
  height: number;
}

export interface Post {
  bright: twgl.ProgramInfo;
  blur: twgl.ProgramInfo;
  composite: twgl.ProgramInfo;
  /** An empty vertex array: the post shaders build their triangle from gl_VertexID. */
  vao: WebGLVertexArrayObject;
  targets: PostTargets | undefined;
}

const COLOR = (gl: WebGL2RenderingContext): twgl.AttachmentOptions[] => [
  { format: gl.RGBA, min: gl.LINEAR, mag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE },
];

export function createPost(gl: WebGL2RenderingContext): Post {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("could not allocate a vertex array");
  return {
    bright: compileProgram(gl, postSource, ["PASS_BRIGHT"]),
    blur: compileProgram(gl, postSource, ["PASS_BLUR"]),
    composite: compileProgram(gl, postSource, ["PASS_COMPOSITE"]),
    vao,
    targets: undefined,
  };
}

/** (Re)creates the render targets for a canvas of this size in device pixels. */
export function sizePost(
  gl: WebGL2RenderingContext,
  post: Post,
  width: number,
  height: number,
): void {
  const half = (n: number): number => Math.max(1, n >> 1);
  const existing = post.targets;
  if (existing && existing.width === width && existing.height === height) return;
  if (existing) {
    twgl.resizeFramebufferInfo(gl, existing.scene, COLOR(gl), width, height);
    twgl.resizeFramebufferInfo(gl, existing.ping, COLOR(gl), half(width), half(height));
    twgl.resizeFramebufferInfo(gl, existing.pong, COLOR(gl), half(width), half(height));
    existing.width = width;
    existing.height = height;
    return;
  }
  post.targets = {
    scene: twgl.createFramebufferInfo(gl, COLOR(gl), width, height),
    ping: twgl.createFramebufferInfo(gl, COLOR(gl), half(width), half(height)),
    pong: twgl.createFramebufferInfo(gl, COLOR(gl), half(width), half(height)),
    width,
    height,
  };
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

/** Bright pass, two blur rounds, then composite onto the canvas framebuffer. */
export function runBloom(gl: WebGL2RenderingContext, post: Post, strength: number): void {
  const t = post.targets;
  if (!t) return;
  gl.disable(gl.BLEND);
  const hw = Math.max(1, t.width >> 1);
  const hh = Math.max(1, t.height >> 1);

  twgl.bindFramebufferInfo(gl, t.ping);
  fullscreen(gl, post, post.bright, { uTex: texOf(t.scene) });

  for (let round = 0; round < 2; round++) {
    twgl.bindFramebufferInfo(gl, t.pong);
    fullscreen(gl, post, post.blur, {
      uTex: texOf(t.ping),
      uTexel: [1 / hw, 1 / hh],
      uDir: [1, 0],
    });
    twgl.bindFramebufferInfo(gl, t.ping);
    fullscreen(gl, post, post.blur, {
      uTex: texOf(t.pong),
      uTexel: [1 / hw, 1 / hh],
      uDir: [0, 1],
    });
  }

  twgl.bindFramebufferInfo(gl, null);
  gl.viewport(0, 0, t.width, t.height);
  fullscreen(gl, post, post.composite, {
    uTex: texOf(t.scene),
    uBloom: texOf(t.ping),
    uStrength: strength,
  });
}
