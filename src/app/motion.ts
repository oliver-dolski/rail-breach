/** The part of MediaQueryList the watcher needs, so a test can stand in for the browser. */
export interface MotionMedia {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

export interface MotionWatch {
  /** Whether reduced motion is on right now. */
  current(): boolean;
  /** Stops following the preference. */
  stop(): void;
}

/**
 * Follows the reduced-motion preference for as long as the page lives: the OS setting can
 * change while the show runs, and a viewer who turns it on should see the map calm down at
 * once, not after a reload. onChange gets the new value on every change, never the initial one.
 */
export function watchReducedMotion(
  media: MotionMedia,
  onChange: (reduced: boolean) => void,
): MotionWatch {
  let reduced = media.matches;
  const listener = (event: { matches: boolean }): void => {
    reduced = event.matches;
    onChange(reduced);
  };
  media.addEventListener("change", listener);
  return {
    current: () => reduced,
    stop: () => media.removeEventListener("change", listener),
  };
}
