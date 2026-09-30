import * as twgl from "twgl.js";
import type { Layout } from "../content/layout";
import type { Content } from "../content/types";
import { fitMap, viewUniform } from "./geometry";
import { type GlResources, initGL } from "./gl/context";
import { runBloom, sizePost } from "./gl/post";
import { disposePrimitives, type Frame, type Primitives } from "./gl/primitives";
import { drawMap } from "./layers/map";
import { drawParticles } from "./layers/particles";
import { NEUTRAL } from "./palette";
import {
  ambientParticles,
  PARTICLE_FLOATS,
  type ParticleRing,
  writeParticle,
} from "./particleRing";
import type { RenderView } from "./view";

export interface RendererOptions {
  reducedMotion: boolean;
}

export interface Geometry {
  /** Device pixels per map unit. */
  scale: number;
  /** Letterbox offset in device pixels. */
  ox: number;
  oy: number;
}

/**
 * The render pipeline: scene into a texture, half-resolution bloom, composite
 * onto the canvas. It only ever reads the RenderView it is handed. After a lost
 * context call rebuild() and it recreates every GL resource from scratch.
 */
export class MapRenderer {
  private res: GlResources | undefined;
  private width = 1;
  private height = 1;
  private fit: Geometry = { scale: 1, ox: 0, oy: 0 };
  private readonly ambient: Float32Array;
  private readonly ambientCount: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly layout: Layout,
    content: Content,
    private readonly options: RendererOptions,
  ) {
    // Ambient traffic is decoration that moves: with reduced motion it is left out.
    const list = options.reducedMotion ? [] : ambientParticles(content, layout);
    this.ambient = new Float32Array(Math.max(1, list.length) * PARTICLE_FLOATS);
    list.forEach((p, i) => {
      writeParticle(this.ambient, i * PARTICLE_FLOATS, p);
    });
    this.ambientCount = list.length;
    this.rebuild();
  }

  /** Creates all GL resources again. Safe to call after webglcontextrestored. */
  rebuild(): void {
    this.res = initGL(this.gl);
    sizePost(this.gl, this.res.post, this.width, this.height);
  }

  /** Drops references to resources that died with a lost context. */
  release(): void {
    this.res = undefined;
  }

  dispose(): void {
    if (this.res) disposePrimitives(this.gl, this.res.prims);
    this.res = undefined;
  }

  /** Current fit of the map sheet in the canvas, for positioning DOM labels. */
  geometry(): Geometry {
    return this.fit;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.fit = fitMap(this.width, this.height, this.layout.width, this.layout.height);
    if (this.res) sizePost(this.gl, this.res.post, this.width, this.height);
  }

  draw(view: RenderView, ring: ParticleRing): void {
    const res = this.res;
    if (!res || this.gl.isContextLost()) return;
    const { gl } = this;
    const targets = res.post.targets;
    if (!targets) return;

    const frame: Frame = {
      view: viewUniform(this.fit, this.width, this.height),
      pxPerUnit: this.fit.scale,
      simTime: view.phase / 10,
    };

    twgl.bindFramebufferInfo(gl, targets.scene);
    const [r, g, b] = NEUTRAL.background;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    drawMap(gl, res.prims, view, frame);
    this.drawAmbient(gl, res.prims, frame);
    drawParticles(gl, res.prims, ring, frame);

    runBloom(gl, res.post, this.options.reducedMotion ? 0.5 : 0.8);
  }

  private drawAmbient(gl: WebGL2RenderingContext, prims: Primitives, frame: Frame): void {
    if (this.ambientCount === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    prims.particles.draw(gl, this.ambient, this.ambientCount, {
      uView: frame.view,
      uSimTime: frame.simTime,
    });
  }
}
