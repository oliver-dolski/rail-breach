/**
 * The Follow attack switch: whether the camera may lean toward the zone under attack. It holds
 * the viewer's own choice, the reduced-motion override and a drag tracker, and nothing else;
 * main.ts wires the button, the wheel and the pointer to it. The switch never reads a clock.
 *
 * The viewer takes the camera back by pressing the pill, turning the wheel on the map or
 * dragging more than DRAG_THRESHOLD_PX across it. A plain click (placing a defense) is not
 * a drag. With reduced motion the camera stays home and the pill is disabled; the viewer's own
 * choice comes back when the preference is cleared.
 */

/** A pointer that moves farther than this (CSS pixels) from where it went down is a drag. */
export const DRAG_THRESHOLD_PX = 6;

export const FOLLOW_DISABLED_TITLE = "Camera follow is off because reduced motion is on.";

export interface FollowSwitch {
  /** Whether the camera may follow now. */
  enabled(): boolean;
  /** The pill's aria-pressed: the same as enabled(). */
  pressed(): boolean;
  /** True while reduced motion holds the camera at home. */
  disabled(): boolean;
  /** The pill's title: the reason while disabled, nothing otherwise. */
  title(): string;
  toggle(): void;
  wheel(): void;
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(): void;
  setReducedMotion(on: boolean): void;
}

export function createFollowSwitch(reducedMotion: boolean): FollowSwitch {
  let reduced = reducedMotion;
  /** What the viewer chose; reduced motion overrides it without erasing it. */
  let wanted = true;
  let down: { x: number; y: number } | undefined;

  const enabled = (): boolean => wanted && !reduced;
  return {
    enabled,
    pressed: enabled,
    disabled: () => reduced,
    title: () => (reduced ? FOLLOW_DISABLED_TITLE : ""),
    toggle() {
      if (!reduced) wanted = !wanted;
    },
    wheel() {
      if (!reduced) wanted = false;
    },
    pointerDown(x, y) {
      down = { x, y };
    },
    pointerMove(x, y) {
      if (down === undefined || reduced) return;
      if (Math.hypot(x - down.x, y - down.y) > DRAG_THRESHOLD_PX) wanted = false;
    },
    pointerUp() {
      down = undefined;
    },
    setReducedMotion(on) {
      reduced = on;
    },
  };
}
