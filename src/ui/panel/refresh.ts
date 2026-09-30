import type { SessionStatus } from "../../app/session";

/**
 * Decides when the panel has to be redrawn. A new tick is not the only reason:
 * when the core halts on a broken invariant or the recording stops matching,
 * the tick stops moving but the verdict and the failure text change. Keying the
 * redraw on the tick alone left a stale "HELD" on screen next to a frozen map.
 */
export function panelSignature(tick: number, status: SessionStatus): string {
  return `${tick}|${status.held ? "held" : "breached"}|${status.violations.join(";")}|${status.failure ?? ""}`;
}

export interface RefreshGate {
  /** True the first time a signature is seen, false while it stays the same. */
  changed(tick: number, status: SessionStatus): boolean;
}

export function createRefreshGate(): RefreshGate {
  let shown: string | undefined;
  return {
    changed(tick, status) {
      const signature = panelSignature(tick, status);
      if (signature === shown) return false;
      shown = signature;
      return true;
    },
  };
}
