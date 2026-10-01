import { ALERT_COLORS, NEUTRAL } from "../palette";
import type { LineInstance, PanelInstance, RenderView } from "../view";
import type { IntroLevel } from "./levels";
import type { IntroPose } from "./pose";

/**
 * What makes a layer read as a layer while the intro hangs it in the air: a faint plate across
 * its level, and a lit border that flares once as the packet passes. Both go away by the end of
 * the fold, so the flat board shows nothing of them.
 */

/** Border of the plate, in map units. */
const PLATE_BORDER = 1.6;
/** The flare's border line: width, glow radius. */
const FLARE_WIDTH = 2.6;
const FLARE_GLOW = 12;

function platePanel(level: IntroLevel, alpha: number): PanelInstance {
  const { plate } = level;
  return {
    x: plate.x,
    y: plate.y,
    w: plate.w,
    h: plate.h,
    radius: 4,
    border: PLATE_BORDER,
    fill: NEUTRAL.zoneFill,
    fillTop: 0.07 * alpha,
    fillBottom: 0.025 * alpha,
    edge: NEUTRAL.zoneEdge,
    edgeSide: 0.4 * alpha,
    edgeTop: 0.65 * alpha,
    innerGlow: 14,
    innerGlowAlpha: 0.08 * alpha,
    glow: 0,
  };
}

/** The four sides of the plate as lit lines: they glow and bloom with the other lines. */
function flareLines(level: IntroLevel, flare: number): LineInstance[] {
  const { plate } = level;
  const inset = PLATE_BORDER / 2;
  const x0 = plate.x + inset;
  const y0 = plate.y + inset;
  const x1 = plate.x + plate.w - inset;
  const y1 = plate.y + plate.h - inset;
  const [r, g, b] = ALERT_COLORS.attacker;
  const side = (ax: number, ay: number, bx: number, by: number): LineInstance => ({
    x0: ax,
    y0: ay,
    x1: bx,
    y1: by,
    width: FLARE_WIDTH,
    glow: FLARE_GLOW,
    dash: 0,
    color: [r, g, b, flare],
  });
  return [side(x0, y0, x1, y0), side(x1, y0, x1, y1), side(x1, y1, x0, y1), side(x0, y1, x0, y0)];
}

/**
 * One layer of the intro as a view: the layer's own instances (shared with the full view), the
 * plate in front of its panels, and, while it flares, the lit border in the trail list.
 */
export function layerView(view: RenderView, level: IntroLevel, pose: IntroPose): RenderView {
  const flare = pose.flares[level.index] ?? 0;
  if (pose.plateAlpha <= 0 && flare <= 0) return view;
  return {
    ...view,
    panels:
      pose.plateAlpha > 0 ? [platePanel(level, pose.plateAlpha), ...view.panels] : view.panels,
    trail: flare > 0 ? flareLines(level, flare) : view.trail,
  };
}
