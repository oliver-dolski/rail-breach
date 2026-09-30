import { describe, expect, it } from "vitest";
import { CONTEXT_RESTORE_GRACE_MS, createLossGuard, type Timers } from "../../src/app/recovery";
import { CONTEXT_LOST_MESSAGE, showFallback } from "../../src/ui/fallback";

/** Timers that only fire when the test says so. */
function manualTimers(): Timers & { pending(): number; fire(): void } {
  const due = new Map<number, () => void>();
  let next = 1;
  return {
    set(callback) {
      const id = next++;
      due.set(id, callback);
      return id;
    },
    clear(handle) {
      due.delete(handle as number);
    },
    pending: () => due.size,
    fire() {
      const all = [...due.values()];
      due.clear();
      for (const callback of all) callback();
    },
  };
}

describe("a lost WebGL context", () => {
  it("gives up after the grace period when it is never restored", () => {
    const timers = manualTimers();
    let gaveUp = 0;
    const guard = createLossGuard(timers, CONTEXT_RESTORE_GRACE_MS, () => {
      gaveUp++;
    });
    guard.lost();
    expect(gaveUp).toBe(0);
    timers.fire();
    expect(gaveUp).toBe(1);
  });

  it("keeps the map when the browser restores it in time", () => {
    const timers = manualTimers();
    let gaveUp = 0;
    const guard = createLossGuard(timers, CONTEXT_RESTORE_GRACE_MS, () => {
      gaveUp++;
    });
    guard.lost();
    guard.restored();
    expect(timers.pending()).toBe(0);
    timers.fire();
    expect(gaveUp).toBe(0);
  });

  it("restarts the wait on a second loss and shows an explanation, not a frozen page", () => {
    const timers = manualTimers();
    const message = { textContent: "" as string | null };
    const els = {
      canvas: { hidden: false as boolean | string },
      labels: { hidden: false as boolean | string },
      fallback: { hidden: true as boolean | string },
      message,
    };
    const guard = createLossGuard(timers, CONTEXT_RESTORE_GRACE_MS, () =>
      showFallback(els, "the context was not restored", CONTEXT_LOST_MESSAGE),
    );
    guard.lost();
    guard.restored();
    guard.lost();
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(els.fallback.hidden).toBe(false);
    expect(els.canvas.hidden).toBe(true);
    expect(message.textContent).toContain("did not come back");
  });
});
