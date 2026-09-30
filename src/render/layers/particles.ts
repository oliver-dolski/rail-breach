import { blendAdditive, type Frame, type Primitives } from "../gl/primitives";
import type { ParticleRing } from "../particleRing";

/**
 * Draws packet particles. Positions are computed in the vertex shader from the
 * simulation clock, so a frame costs one instanced draw however many particles
 * are in flight. The ring is capped, so the cost has a ceiling too.
 */
export function drawParticles(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  ring: ParticleRing,
  frame: Frame,
): void {
  blendAdditive(gl);
  prims.particles.draw(gl, ring.data, ring.count, {
    uView: frame.view,
    uSimTime: frame.simTime,
  });
}
