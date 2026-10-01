import * as twgl from "twgl.js";
import { NEUTRAL } from "../palette";
import discSource from "../shaders/disc.glsl?raw";
import groundSource from "../shaders/ground.glsl?raw";
import lineSource from "../shaders/line.glsl?raw";
import panelSource from "../shaders/panel.glsl?raw";
import particleSource from "../shaders/particle.glsl?raw";
import type { DiscInstance, LineInstance, PanelInstance } from "../view";
import { EMISSIVE_MAX, EMISSIVE_PER_GLOW } from "./tier";

/**
 * Instanced quads for everything the map draws. Lines are quads whose width and
 * glow come from a distance field in the fragment shader (never gl.lineWidth,
 * which is capped at 1 on most drivers), and round things are quads with a
 * distance field per shape (never gl.POINTS, whose size limits vary).
 *
 * twgl is used here, and only under src/render, to compile programs and set
 * uniforms. Buffers and vertex arrays are plain WebGL2.
 */

export interface Frame {
  /** Map to clip: scale x, scale y, offset x, offset y. */
  view: readonly [number, number, number, number];
  /** Device pixels per map unit, for edge anti-aliasing. */
  pxPerUnit: number;
  /** Simulation time in seconds, for particles. */
  simTime: number;
  /**
   * Emissive gain per glow radius unit and its cap. Left out, glowing cores are driven above
   * white for the bloom pass; a tier that draws into an 8-bit target passes NO_EMISSIVE.
   */
  emissive?: readonly [number, number];
  /**
   * The intro's layer matrix: a map point (x, y, 0) to clip space. When it is set the primitives
   * use their MATRIX program and `view` is not read.
   */
  matrix?: Float32Array;
  /** The intro fades a layer in with this; only the MATRIX programs read it. */
  alpha?: number;
}

/** The placement uniforms of a frame: the 2D fit, or the intro's matrix with its fade. */
export function placement(frame: Frame): Record<string, unknown> {
  return frame.matrix === undefined
    ? { uView: frame.view }
    : { uMatrix: frame.matrix, uAlpha: frame.alpha ?? 1 };
}

/** The emissive gain of the HDR pipeline: one source, shared by lines and discs. */
export const HDR_EMISSIVE: readonly [number, number] = [EMISSIVE_PER_GLOW, EMISSIVE_MAX];
/** No gain: the colour a primitive carries is the colour it shows. */
export const NO_EMISSIVE: readonly [number, number] = [0, 0];

export const LINE_FLOATS = 11;
export const DISC_FLOATS = 9;
export const PANEL_FLOATS = 19;
export const PARTICLE_FLOATS_PER_INSTANCE = 12;

/** Dot grid look (UI-SPEC 1.1): pitch and radius live in ground.glsl, colour and alpha here. */
const GROUND_ALPHA = 0.22;

interface Attrib {
  location: number;
  size: number;
  offset: number;
}

/** Compiles a single-file shader: the file holds both stages behind VERTEX / FRAGMENT guards. */
export function compileProgram(
  gl: WebGL2RenderingContext,
  source: string,
  defines: readonly string[] = [],
): twgl.ProgramInfo {
  const head = `#version 300 es\n${defines.map((d) => `#define ${d}\n`).join("")}`;
  const failures: string[] = [];
  const info = twgl.createProgramInfo(
    gl,
    [`${head}#define VERTEX\n${source}`, `${head}#define FRAGMENT\n${source}`],
    undefined,
    undefined,
    (message: string) => {
      failures.push(message);
    },
  );
  if (failures.length > 0 || !info) {
    throw new Error(`shader failed to build: ${failures.join("\n")}`);
  }
  return info;
}

/** One unit quad drawn many times, with per-instance attributes from a single buffer. */
export class InstancedPass {
  readonly program: twgl.ProgramInfo;
  /** The same shader placed by a matrix instead of the 2D fit: the intro's layers. */
  readonly matrixProgram: twgl.ProgramInfo;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private scratch: Float32Array;

  constructor(
    gl: WebGL2RenderingContext,
    source: string,
    private readonly floatsPerInstance: number,
    attribs: readonly Attrib[],
  ) {
    this.program = compileProgram(gl, source);
    try {
      this.matrixProgram = compileProgram(gl, source, ["MATRIX"]);
    } catch (error) {
      gl.deleteProgram(this.program.program);
      throw error;
    }
    this.scratch = new Float32Array(floatsPerInstance * 256);

    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    const instances = gl.createBuffer();
    if (!vao || !quad || !instances) throw new Error("could not allocate GL objects");
    this.vao = vao;
    this.quad = quad;
    this.instances = instances;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    const stride = floatsPerInstance * 4;
    for (const a of attribs) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribPointer(a.location, a.size, gl.FLOAT, false, stride, a.offset * 4);
      gl.vertexAttribDivisor(a.location, 1);
    }
    gl.bindVertexArray(null);
  }

  /** A scratch array big enough for `count` instances; grows, never shrinks. */
  buffer(count: number): Float32Array {
    const need = count * this.floatsPerInstance;
    if (this.scratch.length < need) {
      this.scratch = new Float32Array(Math.max(need, this.scratch.length * 2));
    }
    return this.scratch;
  }

  draw(
    gl: WebGL2RenderingContext,
    data: Float32Array,
    count: number,
    uniforms: Record<string, unknown>,
  ): void {
    if (count === 0) return;
    const program = uniforms.uMatrix === undefined ? this.program : this.matrixProgram;
    gl.useProgram(program.program);
    twgl.setUniforms(program, uniforms);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      data.subarray(0, count * this.floatsPerInstance),
      gl.DYNAMIC_DRAW,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.instances);
    gl.deleteProgram(this.program.program);
    gl.deleteProgram(this.matrixProgram.program);
  }
}

/** A pass that fills the screen from gl_VertexID alone: no vertex buffer, only uniforms. */
export class FullscreenPass {
  readonly program: twgl.ProgramInfo;
  private readonly vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext, source: string) {
    this.program = compileProgram(gl, source);
    const vao = gl.createVertexArray();
    if (!vao) {
      gl.deleteProgram(this.program.program);
      throw new Error("could not allocate a vertex array");
    }
    this.vao = vao;
  }

  draw(gl: WebGL2RenderingContext, uniforms: Record<string, unknown>): void {
    gl.useProgram(this.program.program);
    twgl.setUniforms(this.program, uniforms);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program.program);
  }
}

export interface Primitives {
  lines: InstancedPass;
  discs: InstancedPass;
  particles: InstancedPass;
  /** Translucent zone panels. */
  panels: InstancedPass;
  /** The dot grid under the panels. */
  ground: FullscreenPass;
}

export function createPrimitives(gl: WebGL2RenderingContext): Primitives {
  return {
    lines: new InstancedPass(gl, lineSource, LINE_FLOATS, [
      { location: 1, size: 4, offset: 0 },
      { location: 2, size: 3, offset: 4 },
      { location: 3, size: 4, offset: 7 },
    ]),
    discs: new InstancedPass(gl, discSource, DISC_FLOATS, [
      { location: 1, size: 4, offset: 0 },
      { location: 2, size: 1, offset: 4 },
      { location: 3, size: 4, offset: 5 },
    ]),
    particles: new InstancedPass(gl, particleSource, PARTICLE_FLOATS_PER_INSTANCE, [
      { location: 1, size: 4, offset: 0 },
      { location: 2, size: 4, offset: 4 },
      { location: 3, size: 4, offset: 8 },
    ]),
    panels: new InstancedPass(gl, panelSource, PANEL_FLOATS, [
      { location: 1, size: 4, offset: 0 },
      { location: 2, size: 4, offset: 4 },
      { location: 3, size: 4, offset: 8 },
      { location: 4, size: 4, offset: 12 },
      { location: 5, size: 3, offset: 16 },
    ]),
    ground: new FullscreenPass(gl, groundSource),
  };
}

export function disposePrimitives(gl: WebGL2RenderingContext, p: Primitives): void {
  p.lines.dispose(gl);
  p.discs.dispose(gl);
  p.particles.dispose(gl);
  p.panels.dispose(gl);
  p.ground.dispose(gl);
}

/** Premultiplied alpha: colours carry their own glow, overlaps cover what is below. */
export function blendPremultiplied(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

/**
 * Additive: particles only ever add light. Their shader writes alpha 0, so this blend is the sum
 * of colours. It is spelled this way and not as (ONE, ONE) because a half-float target adds the
 * latter up differently from one run to the next on some drivers, which breaks the capture.
 */
export function blendAdditive(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

function writeLine(data: Float32Array, o: number, l: LineInstance): void {
  data[o] = l.x0;
  data[o + 1] = l.y0;
  data[o + 2] = l.x1;
  data[o + 3] = l.y1;
  data[o + 4] = l.width;
  data[o + 5] = l.glow;
  data[o + 6] = l.dash;
  data[o + 7] = l.color[0];
  data[o + 8] = l.color[1];
  data[o + 9] = l.color[2];
  data[o + 10] = l.color[3];
}

export function drawLines(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  instances: readonly LineInstance[],
  frame: Frame,
): void {
  drawLineGroups(gl, prims, [instances], frame);
}

/** Several line lists written one after the other into one buffer and drawn with one call. */
export function drawLineGroups(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  groups: readonly (readonly LineInstance[])[],
  frame: Frame,
): void {
  let total = 0;
  for (const g of groups) total += g.length;
  const data = prims.lines.buffer(total);
  let o = 0;
  for (const g of groups) {
    for (const l of g) {
      writeLine(data, o, l);
      o += LINE_FLOATS;
    }
  }
  prims.lines.draw(gl, data, total, {
    ...placement(frame),
    uPxPerUnit: frame.pxPerUnit,
    uEmissive: frame.emissive ?? HDR_EMISSIVE,
  });
}

export function drawDiscs(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  instances: readonly DiscInstance[],
  frame: Frame,
): void {
  const data = prims.discs.buffer(instances.length);
  let o = 0;
  for (const d of instances) {
    data[o] = d.x;
    data[o + 1] = d.y;
    data[o + 2] = d.radius;
    data[o + 3] = d.shape;
    data[o + 4] = d.glow;
    data[o + 5] = d.color[0];
    data[o + 6] = d.color[1];
    data[o + 7] = d.color[2];
    data[o + 8] = d.color[3];
    o += DISC_FLOATS;
  }
  prims.discs.draw(gl, data, instances.length, {
    ...placement(frame),
    uPxPerUnit: frame.pxPerUnit,
    uEmissive: frame.emissive ?? HDR_EMISSIVE,
  });
}

export function drawPanels(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  panels: readonly PanelInstance[],
  frame: Frame,
): void {
  const data = prims.panels.buffer(panels.length);
  let o = 0;
  for (const p of panels) {
    data[o] = p.x;
    data[o + 1] = p.y;
    data[o + 2] = p.w;
    data[o + 3] = p.h;
    data[o + 4] = p.radius;
    data[o + 5] = p.border;
    data[o + 6] = p.innerGlow;
    data[o + 7] = p.glow;
    data[o + 8] = p.fill[0];
    data[o + 9] = p.fill[1];
    data[o + 10] = p.fill[2];
    data[o + 11] = p.fillTop;
    data[o + 12] = p.edge[0];
    data[o + 13] = p.edge[1];
    data[o + 14] = p.edge[2];
    data[o + 15] = p.edgeSide;
    data[o + 16] = p.fillBottom;
    data[o + 17] = p.edgeTop;
    data[o + 18] = p.innerGlowAlpha;
    o += PANEL_FLOATS;
  }
  prims.panels.draw(gl, data, panels.length, {
    ...placement(frame),
    uPxPerUnit: frame.pxPerUnit,
    uEmissive: frame.emissive ?? HDR_EMISSIVE,
  });
}

/** The render target and the sheet it shows, for mapping a pixel back to map units. */
export interface GroundSize {
  width: number;
  height: number;
  sheetWidth: number;
  sheetHeight: number;
}

export function drawGround(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  frame: Frame,
  size: GroundSize,
): void {
  blendPremultiplied(gl);
  const [r, g, b] = NEUTRAL.ground;
  prims.ground.draw(gl, {
    uView: frame.view,
    uCanvas: [size.width, size.height],
    uSheet: [size.sheetWidth, size.sheetHeight],
    uPxPerUnit: frame.pxPerUnit,
    uDot: [r, g, b, GROUND_ALPHA],
  });
}
