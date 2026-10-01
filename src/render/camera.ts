import type { Layout } from "../content/layout";
import type { World } from "../core/sim/world";
import type { Fit } from "./geometry";
import { nodeVisualState } from "./view";

/**
 * The follow camera. It leans toward the zone the newest running operation acts on, holds that
 * view for a moment after the operations stop, and pulls back home once the railway feels the
 * attack. It is stepped once per simulation tick and never reads a clock, so it is a pure
 * function of the tick sequence: the same in capture, on replay and under any frame rate. The
 * renderer interpolates the last two poses with the loop's alpha, and nothing here writes the world.
 *
 * Only + and * are used in the easing, so the result is bit-identical across machines.
 */

/** Share of the gap to the target covered each tick (time constant about 1.6 s). */
export const CAMERA_EASE = 0.06;
/** The same, when follow is switched off and the camera heads home (about 0.6 s). */
export const CAMERA_OFF_EASE = 0.15;
export const FOCUS_ZOOM = 1.3;
/** How far from the sheet centre toward the zone centre the focus pose sits. */
export const FOCUS_PULL = 0.6;
/** Ticks the last focus is held after the operations stop (3 s). */
export const FOCUS_HOLD_TICKS = 30;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 1.3;

export interface CameraPose {
  zoom: number;
  /** The map point at the middle of the canvas. */
  cx: number;
  cy: number;
}

export interface CameraState extends CameraPose {
  /** The zone the camera is leaning toward, if any. */
  focus: string | undefined;
  /** Ticks of focus left once no operation runs. */
  holdLeft: number;
  /** True for the rest of the show once the railway felt the attack (see pullsBack). */
  latched: boolean;
  /** Trains standing at the camera's first step after a reset; undefined before that step. */
  baseline: number | undefined;
}

/** Zoom 1 on the middle of the sheet, nothing focused, nothing latched. */
export function homeCamera(layout: Layout): CameraState {
  return {
    zoom: MIN_ZOOM,
    cx: layout.width / 2,
    cy: layout.height / 2,
    focus: undefined,
    holdLeft: 0,
    latched: false,
    baseline: undefined,
  };
}

/**
 * The zone of the newest running operation (the highest id; `world.ops` holds running ones
 * only): its target once it has arrived, otherwise the machine it is travelling through.
 */
export function focusZoneOf(
  world: World,
  zoneOfNode: ReadonlyMap<string, string>,
): string | undefined {
  let newest: World["ops"][number] | undefined;
  for (const op of world.ops) if (newest === undefined || op.id > newest.id) newest = op;
  if (newest === undefined) return undefined;
  const node = newest.hop >= newest.path.length - 1 ? newest.target : newest.path[newest.hop];
  return node === undefined ? undefined : zoneOfNode.get(node);
}

export interface CameraSignals {
  trainsStanding: number;
  nodesLost: number;
}

/** What the camera reads of the railway: trains at a standstill and machines that lost control. */
export function cameraSignals(world: World): CameraSignals {
  let trainsStanding = 0;
  for (const train of world.trains) if (train.speedDmPerTick === 0) trainsStanding++;
  let nodesLost = 0;
  for (const node of world.nodes) if (nodeVisualState(node) === "lost") nodesLost++;
  return { trainsStanding, nodesLost };
}

/**
 * When the camera gives up on following and stays home. The plain rule "a train stands" would
 * keep it home from tick 1, because trains already wait at signals when the show starts. So it
 * is the railway feeling the attack: a machine has lost control and more trains stand than when
 * the show began. One function, so the rule can be swapped without touching the rest.
 */
function pullsBack(signals: CameraSignals, baseline: number): boolean {
  return signals.nodesLost >= 1 && signals.trainsStanding > baseline;
}

/** The pose that frames a zone: zoom 1.3, centre pulled 0.6 toward the zone, window kept on the sheet. */
export function focusPose(zoneId: string, layout: Layout): CameraPose {
  const home = homeCamera(layout);
  const zone = layout.zones.find((z) => z.id === zoneId);
  if (zone === undefined) return { zoom: home.zoom, cx: home.cx, cy: home.cy };
  const zoom = FOCUS_ZOOM;
  const halfW = layout.width / zoom / 2;
  const halfH = layout.height / zoom / 2;
  const wantX = home.cx + (zone.x + zone.w / 2 - home.cx) * FOCUS_PULL;
  const wantY = home.cy + (zone.y + zone.h / 2 - home.cy) * FOCUS_PULL;
  return {
    zoom,
    cx: Math.min(Math.max(wantX, halfW), layout.width - halfW),
    cy: Math.min(Math.max(wantY, halfH), layout.height - halfH),
  };
}

export interface CameraInput {
  world: World;
  zoneOfNode: ReadonlyMap<string, string>;
  layout: Layout;
  /** The Follow attack switch. Off means: head home, quickly. */
  enabled: boolean;
  /** Reduced motion keeps the camera at home with no easing at all. */
  reducedMotion: boolean;
}

/** One simulation tick of the camera. Returns a new state; the old one and the world are untouched. */
export function stepCamera(state: CameraState, input: CameraInput): CameraState {
  const { world, zoneOfNode, layout } = input;
  const signals = cameraSignals(world);
  const baseline = state.baseline ?? signals.trainsStanding;
  const latched = state.latched || pullsBack(signals, baseline);

  const zone = focusZoneOf(world, zoneOfNode);
  let focus = state.focus;
  let holdLeft = state.holdLeft;
  if (zone !== undefined) {
    focus = zone;
    holdLeft = FOCUS_HOLD_TICKS;
  } else if (world.ops.length === 0) {
    holdLeft = Math.max(0, holdLeft - 1);
    if (holdLeft === 0) focus = undefined;
  }

  const home = homeCamera(layout);
  if (input.reducedMotion) {
    return { ...home, focus, holdLeft, latched, baseline };
  }

  const aim: CameraPose =
    latched || !input.enabled || focus === undefined ? home : focusPose(focus, layout);
  const ease = input.enabled ? CAMERA_EASE : CAMERA_OFF_EASE;
  const zoom = state.zoom + (aim.zoom - state.zoom) * ease;
  return {
    zoom: Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM),
    cx: state.cx + (aim.cx - state.cx) * ease,
    cy: state.cy + (aim.cy - state.cy) * ease,
    focus,
    holdLeft,
    latched,
    baseline,
  };
}

/** The pose between two steps, for drawing between ticks. */
export function lerpPose(a: CameraPose, b: CameraPose, alpha: number): CameraPose {
  return {
    zoom: a.zoom + (b.zoom - a.zoom) * alpha,
    cx: a.cx + (b.cx - a.cx) * alpha,
    cy: a.cy + (b.cy - a.cy) * alpha,
  };
}

/**
 * The map-to-canvas fit under a pose: the home fit scaled by the zoom about the middle of the
 * canvas, with the pose centre landing there. At the home pose it is the home fit itself, bit
 * for bit. The shaders, the label positions and the click pick all take this one fit.
 */
export function cameraFit(home: Fit, pose: CameraPose, layout: Layout): Fit {
  const scale = home.scale * pose.zoom;
  const halfW = (layout.width / 2) * home.scale;
  const halfH = (layout.height / 2) * home.scale;
  return {
    scale,
    ox: home.ox + (halfW - pose.cx * scale),
    oy: home.oy + (halfH - pose.cy * scale),
  };
}

/** The camera as the page holds it: the state after the newest tick and the pose before it. */
export class CameraTrack {
  private state: CameraState;
  private before: CameraPose;

  constructor(private readonly layout: Layout) {
    this.state = homeCamera(layout);
    this.before = this.state;
  }

  /** Back to the home pose at once, with no easing: a restart or a new scenario. */
  reset(): void {
    this.state = homeCamera(this.layout);
    this.before = this.state;
  }

  step(input: Omit<CameraInput, "layout">): void {
    this.before = this.state;
    this.state = stepCamera(this.state, { ...input, layout: this.layout });
  }

  current(): CameraState {
    return this.state;
  }

  /** The pose to draw: `alpha` of the way from the previous step to the newest. */
  pose(alpha: number): CameraPose {
    return lerpPose(this.before, this.state, alpha);
  }
}
