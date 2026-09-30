import * as twgl from "twgl.js";
import discSource from "../shaders/disc.glsl?raw";
import lineSource from "../shaders/line.glsl?raw";
import particleSource from "../shaders/particle.glsl?raw";
import type { DiscInstance, LineInstance } from "../view";

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
}

export const LINE_FLOATS = 11;
export const DISC_FLOATS = 9;
export const PARTICLE_FLOATS_PER_INSTANCE = 12;

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
    gl.useProgram(this.program.program);
    twgl.setUniforms(this.program, uniforms);
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
  }
}

export interface Primitives {
  lines: InstancedPass;
  discs: InstancedPass;
  particles: InstancedPass;
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
  };
}

export function disposePrimitives(gl: WebGL2RenderingContext, p: Primitives): void {
  p.lines.dispose(gl);
  p.discs.dispose(gl);
  p.particles.dispose(gl);
}

/** Premultiplied alpha: colours carry their own glow, overlaps cover what is below. */
export function blendPremultiplied(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

/** Additive: particles only ever add light. */
export function blendAdditive(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
}

export function drawLines(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  instances: readonly LineInstance[],
  frame: Frame,
): void {
  const data = prims.lines.buffer(instances.length);
  let o = 0;
  for (const l of instances) {
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
    o += LINE_FLOATS;
  }
  prims.lines.draw(gl, data, instances.length, {
    uView: frame.view,
    uPxPerUnit: frame.pxPerUnit,
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
    uView: frame.view,
    uPxPerUnit: frame.pxPerUnit,
  });
}
