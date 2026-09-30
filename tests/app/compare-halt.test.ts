import { describe, expect, it, vi } from "vitest";
import { compareSession } from "../../src/app/compare";
import { createAttractSession } from "../../src/app/session";
import { InvariantViolation } from "../../src/core/rail/invariants";
import type { Action } from "../../src/core/sim/actions";
import { indicatorText, readInvariant } from "../../src/ui/panel/indicator";
import { createRefreshGate } from "../../src/ui/panel/refresh";

const breach = vi.hoisted(() => ({ armed: false }));

// The real step, except that it reports a broken invariant once armed: the engine has no
// legitimate way to reach that state, so the path has to be forced to be tested at all.
vi.mock("../../src/core/sim/step", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/sim/step")>();
  return {
    ...actual,
    step: (...args: Parameters<typeof actual.step>) => {
      if (breach.armed) throw new InvariantViolation(["section sec-x holds a and b"]);
      return actual.step(...args);
    },
  };
});

const firewall: Action = { type: "defense.place", kind: "firewall", on: { conduit: "c-dmz-ctrl" } };

describe("an invariant violation inside a comparison run", () => {
  it("is thrown on and latches the indicator as breached, never left on HELD", () => {
    const session = createAttractSession();
    session.advance(20);
    session.dispatch(firewall);
    session.advance(10);
    const gate = createRefreshGate();
    expect(gate.changed(session.world().tick, session.status())).toBe(true);
    expect(session.status().held).toBe(true);

    breach.armed = true;
    try {
      expect(() => compareSession(session)).toThrow(InvariantViolation);
    } finally {
      breach.armed = false;
    }

    const status = session.status();
    expect(status.held).toBe(false);
    expect(status.violations).toEqual(["section sec-x holds a and b"]);
    // The panel redraws at an unchanged tick and the indicator carries the core's text.
    expect(gate.changed(session.world().tick, status)).toBe(true);
    const view = indicatorText({
      assertedHeld: status.held,
      assertedViolations: status.violations,
      reading: readInvariant(session.world(), session.index),
      checkedTicks: status.checkedTicks,
    });
    expect(view.label).toBe("safety invariant: BREACHED");
    expect(view.detail).toBe("section sec-x holds a and b");
  });
});
