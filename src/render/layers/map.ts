import {
  blendPremultiplied,
  drawDiscs,
  drawLineGroups,
  drawLines,
  drawPanels,
  type Frame,
  type Primitives,
} from "../gl/primitives";
import type { RenderView } from "../view";

/**
 * The map itself, drawn back to front: zone panels, links, track, set routes, lit alert links and
 * diode arrows (one draw), trains, then the glyphs that must stay readable on top (signal lamps,
 * halos, nodes, defenses). The dot grid goes under all of it and the particles over it, each in
 * its own pass.
 */
export function drawMap(
  gl: WebGL2RenderingContext,
  prims: Primitives,
  view: RenderView,
  frame: Frame,
): void {
  blendPremultiplied(gl);
  drawPanels(gl, prims, view.panels, frame);
  drawLines(gl, prims, view.links, frame);
  drawLines(gl, prims, view.track, frame);
  drawLines(gl, prims, view.routes, frame);
  drawLineGroups(gl, prims, [view.alerts, view.defenseArrows], frame);
  drawLines(gl, prims, view.trains, frame);
  drawDiscs(gl, prims, view.signals, frame);
  drawDiscs(gl, prims, view.halos, frame);
  drawDiscs(gl, prims, view.nodes, frame);
  drawDiscs(gl, prims, view.defenses, frame);
}
