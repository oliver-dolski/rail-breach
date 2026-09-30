/**
 * Switching scenario, as a transaction: the running session is only replaced once the new one
 * has been built. When building fails (a scenario that does not fit the content, a recording
 * that no longer matches), the old session keeps running, the selector goes back to it, and
 * the viewer is told; nothing about the running show changes.
 */
export interface SwitchDeps<S> {
  /** Id of the scenario that is running. */
  runningId(): string;
  /** Builds a session for `id`; throws when the scenario does not fit, undefined for an unknown id. */
  build(id: string): S | undefined;
  /** Installs the new session and clears what the last one left on screen. */
  adopt(session: S, id: string): void;
  /** Puts the selector back on the scenario that is running. */
  restore(id: string): void;
  /** A line for the viewer; empty clears it. */
  say(text: string): void;
}

export function switchScenario<S>(id: string, deps: SwitchDeps<S>): void {
  const running = deps.runningId();
  if (id === running) return;
  let next: S | undefined;
  try {
    next = deps.build(id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    deps.restore(running);
    deps.say(`That scenario could not start, so the running one carries on: ${detail}`);
    return;
  }
  if (next === undefined) {
    deps.restore(running);
    return;
  }
  deps.adopt(next, id);
  deps.say("");
}
