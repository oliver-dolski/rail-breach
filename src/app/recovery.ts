/**
 * What happens when the graphics side fails: the panel and the simulation carry
 * on, the map is swapped for the still and the viewer is told why. None of this
 * touches the simulation.
 */

/** Runs `create`; when it throws, reports why (for the fallback) and returns undefined. */
export function attempt<T>(create: () => T, onFail: (reason: string) => void): T | undefined {
  try {
    return create();
  } catch (error) {
    onFail(error instanceof Error ? error.message : "unknown error");
    return undefined;
  }
}
