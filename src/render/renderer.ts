import * as twgl from "twgl.js";
import type { Layout } from "../content/layout";
import type { Content } from "../content/types";
import { TICKS_PER_SECOND } from "../core/sim/constants";
import { type CameraPose, cameraFit, homeCamera } from "./camera";
import { fitMap, viewUniform } from "./geometry";
import { disposeGL, type GlResources, initGL } from "./gl/context";
import { disposePost, runBloom, sizePost } from "./gl/post";
import {
  blendAdditive,
  drawGround,
  type Frame,
  HDR_EMISSIVE,
  NO_EMISSIVE,
  type Primitives,
  placement,
} from "./gl/primitives";
import {
  bloomSettings,
  chooseTier,
  FrameGovernor,
  firstWorking,
  type RenderTier,
  tiersFrom,
} from "./gl/tier";
import {
  FOLD_END_MS,
  INTRO_MS,
  type IntroSheet,
  introPose,
  introSheet,
  layerMatrix,
} from "./intro/pose";
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
  /** The capture build: the tier is fixed at what the GPU offers, nothing steps it down. */
  capture: boolean;
}

export interface Geometry {
  /** Device pixels per map unit. */
  scale: number;
  /** Letterbox offset in device pixels. */
  ox: number;
  oy: number;
}

/**
 * The render pipeline: scene into a texture, a chain of bloom levels, composite
 * onto the canvas. The tier (high, standard, lite) is chosen from what the GPU
 * offers and only ever steps down. It only ever reads the RenderView it is handed.
 * After a lost context call rebuild() and it recreates every GL resource from scratch.
 */
export class MapRenderer {
  private res: GlResources | undefined;
  private width = 1;
  private height = 1;
  /** The fit of the whole sheet in the canvas: the camera at home. */
  private home: Geometry = { scale: 1, ox: 0, oy: 0 };
  /** The fit under the camera pose: what the shaders, the labels and the click pick all use. */
  private fit: Geometry = { scale: 1, ox: 0, oy: 0 };
  private pose: CameraPose;
  private readonly ambient: Float32Array;
  private readonly ambientCount: number;
  private reducedMotion: boolean;
  private current: RenderTier;
  private readonly governor: FrameGovernor;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly layout: Layout,
    content: Content,
    options: RendererOptions,
  ) {
    // The list is always built: whether the ambient traffic is drawn follows the preference,
    // which can change while the show runs.
    this.reducedMotion = options.reducedMotion;
    this.pose = homeCamera(layout);
    // The capture build always runs the tier the GPU offers: nothing steps it down mid-recording.
    this.governor = new FrameGovernor(!options.capture);
    this.current = chooseTier(gl);
    const list = ambientParticles(content, layout);
    this.ambient = new Float32Array(Math.max(1, list.length) * PARTICLE_FLOATS);
    list.forEach((p, i) => {
      writeParticle(this.ambient, i * PARTICLE_FLOATS, p);
    });
    this.ambientCount = list.length;
    this.rebuild();
  }

  /** Follows the reduced-motion preference: with it on the ambient traffic is left out and the bloom is softer. */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /**
   * Feeds one frame delta to the governor. When it says the GPU cannot keep up, the bloom chain
   * is dropped for good (lite) and true is returned so the page can report the new tier.
   */
  noteFrame(dtMs: number): boolean {
    if (this.current === "lite" || !this.governor.feed(dtMs)) return false;
    this.current = "lite";
    const res = this.res;
    if (res) {
      if (res.post) disposePost(this.gl, res.post);
      this.res = { prims: res.prims, post: undefined, tier: "lite" };
    }
    return true;
  }

  /** The tier in use: high, standard or lite. */
  tier(): RenderTier {
    return this.current;
  }

  /** The resources of one tier, sized for the canvas. Frees them again when a target is refused. */
  private build(tier: RenderTier): GlResources {
    const res = initGL(this.gl, tier);
    if (res.post) {
      try {
        sizePost(this.gl, res.post, this.width, this.height);
      } catch (error) {
        disposeGL(this.gl, res);
        throw error;
      }
    }
    return res;
  }

  /**
   * Creates all GL resources again. Safe to call after webglcontextrestored. It starts at the
   * tier in use and falls to a lower one when the GPU refuses; it never climbs back up.
   */
  rebuild(): void {
    const built = firstWorking(tiersFrom(this.current), (tier) => this.build(tier));
    this.res = built.value;
    this.current = built.tier;
  }

  /** Drops references to resources that died with a lost context. */
  release(): void {
    this.res = undefined;
  }

  dispose(): void {
    if (this.res) disposeGL(this.gl, this.res);
    this.res = undefined;
  }

  /** Where the follow camera is looking. Takes effect at the next draw and for every consumer of geometry(). */
  setCamera(pose: CameraPose): void {
    this.pose = pose;
    this.fit = cameraFit(this.home, pose, this.layout);
  }

  /**
   * The fit under the camera, for positioning DOM labels and for the click pick: the same
   * transform the shaders draw with, so a click lands on what is drawn under the pointer.
   */
  geometry(): Geometry {
    return this.fit;
  }

  /** The fit of the whole sheet, the camera at home. Its scale is the label font scale. */
  homeGeometry(): Geometry {
    return this.home;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.home = fitMap(this.width, this.height, this.layout.width, this.layout.height);
    this.fit = cameraFit(this.home, this.pose, this.layout);
    if (this.res?.post) sizePost(this.gl, this.res.post, this.width, this.height);
  }

  /** Binds the scene target (or the canvas without a post chain), clears it and lays the ground. */
  private beginScene(res: GlResources, frame: Frame, ground: boolean): boolean {
    const { gl } = this;
    const targets = res.post?.targets;
    if (res.post && !targets) return false;
    if (targets) {
      twgl.bindFramebufferInfo(gl, targets.scene);
    } else {
      twgl.bindFramebufferInfo(gl, null);
      gl.viewport(0, 0, this.width, this.height);
    }
    const [r, g, b] = NEUTRAL.background;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (ground) {
      drawGround(gl, res.prims, frame, {
        width: this.width,
        height: this.height,
        sheetWidth: this.layout.width,
        sheetHeight: this.layout.height,
      });
    }
    return true;
  }

  /** Emissive gain is only meaningful in the float pipeline; an 8-bit target would clip it. */
  private emissiveFor(res: GlResources): readonly [number, number] {
    return res.tier === "high" ? HDR_EMISSIVE : NO_EMISSIVE;
  }

  draw(view: RenderView, ring: ParticleRing): void {
    const res = this.res;
    if (!res || this.gl.isContextLost()) return;
    const { gl } = this;
    const post = res.post;

    const frame: Frame = {
      view: viewUniform(this.fit, this.width, this.height),
      pxPerUnit: this.fit.scale,
      simTime: view.phase / TICKS_PER_SECOND,
      emissive: this.emissiveFor(res),
    };
    if (!this.beginScene(res, frame, view.ground)) return;
    drawMap(gl, res.prims, view, frame);
    this.drawAmbient(gl, res.prims, frame);
    drawParticles(gl, res.prims, ring, frame);

    if (post) runBloom(gl, post, bloomSettings(res.tier, this.reducedMotion));
  }

  private drawAmbient(gl: WebGL2RenderingContext, prims: Primitives, frame: Frame): void {
    if (this.reducedMotion || this.ambientCount === 0) return;
    blendAdditive(gl);
    prims.particles.draw(gl, this.ambient, this.ambientCount, {
      ...placement(frame),
      uSimTime: frame.simTime,
    });
  }

  /**
   * One frame of the intro: the board drawn through a layer matrix (tilted and pulled apart),
   * the ambient traffic once the layers have settled, then the same bloom as the live board.
   * The camera is at home here. The simulation is paused, so the view is the first world.
   */
  drawIntro(view: RenderView, elapsedMs: number): void {
    const res = this.res;
    if (!res || this.gl.isContextLost()) return;
    const { gl } = this;
    const canvas = { width: this.width, height: this.height };
    const pose = introPose(elapsedMs, this.width / this.height);
    const emissive = this.emissiveFor(res);
    const flat: Frame = {
      view: viewUniform(this.home, this.width, this.height),
      pxPerUnit: this.home.scale,
      simTime: view.phase / TICKS_PER_SECOND,
      emissive,
    };
    if (!this.beginScene(res, flat, view.ground)) return;

    const sheet = this.introSheetOf();
    const layer: Frame = {
      ...flat,
      pxPerUnit: this.home.scale * pose.scale,
      matrix: layerMatrix(pose, 0, this.home, canvas, sheet),
      alpha: pose.fadeIn,
    };
    drawMap(gl, res.prims, view, layer);

    if (pose.ambientAlpha > 0) {
      // The ambient traffic runs on the show clock less what the intro still has to play, so it
      // is already moving when it fades in and is exactly in step when the live board takes over.
      const ambient: Frame = {
        ...flat,
        simTime: flat.simTime - (INTRO_MS - elapsedMs) / 1000,
        matrix: layerMatrix(
          introPose(FOLD_END_MS, this.width / this.height),
          0,
          this.home,
          canvas,
          sheet,
        ),
        alpha: pose.ambientAlpha,
      };
      this.drawAmbient(gl, res.prims, ambient);
    }
    if (res.post) runBloom(gl, res.post, bloomSettings(res.tier, this.reducedMotion));
  }

  private introSheetCache: IntroSheet | undefined;

  private introSheetOf(): IntroSheet {
    this.introSheetCache ??= introSheet(
      [{ x: 0, y: 0, w: this.layout.width, h: this.layout.height }],
      this.layout,
    );
    return this.introSheetCache;
  }
}
