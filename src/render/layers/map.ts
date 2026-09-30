import {
  blendPremultiplied,
  drawDiscs,
  drawLines,
  type Frame,
  type Primitives,
} from "../gl/primitives";
import type { RenderView } from "../view";

/**
 * The map itself, drawn back to front: zone outlines, links, track, set routes,
 * trains, then the glyphs that must stay readable on top (signal lamps, halos,
 * nodes). Particles go over all of it in their own layer.
 */
export function drawMap(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  view: RenderView,
  frame: Frame,
): void {
  blendPremultiplied(gl);
  drawLines(gl, prims, view.zones, frame);
  drawLines(gl, prims, view.links, frame);
  drawLines(gl, prims, view.track, frame);
  drawLines(gl, prims, view.routes, frame);
  drawLines(gl, prims, view.defenseArrows, frame);
  drawLines(gl, prims, view.trains, frame);
  drawDiscs(gl, prims, view.signals, frame);
  drawDiscs(gl, prims, view.halos, frame);
  drawDiscs(gl, prims, view.nodes, frame);
  drawDiscs(gl, prims, view.defenses, frame);
}
