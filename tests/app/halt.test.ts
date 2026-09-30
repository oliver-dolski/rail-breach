import { describe, expect, it, vi } from "vitest";
import { createAttractSession } from "../../src/app/session";
import { InvariantViolation } from "../../src/core/rail/invariants";
import { indicatorText, readInvariant } from "../../src/ui/panel/indicator";
import { createRefreshGate } from "../../src/ui/panel/refresh";

const breach = vi.hoisted(() => ({ armed: false }));

// The real step, except that it reports a broken invariant once armed. The
// engine has no legitimate way to reach this state, which is what makes the
// indicator worth testing: it has to work on a path that never happens.
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

describe("a halt on an invariant violation", () => {
  it("is latched by the session and shown by the panel even though the tick stops moving", () => {
    const session = createAttractSession();
    const gate = createRefreshGate();
    expect(gate.changed(session.world().tick, session.status())).toBe(true);
    expect(gate.changed(session.world().tick, session.status())).toBe(false);

    session.advance(5);
    const before = session.world().tick;
    expect(gate.changed(before, session.status())).toBe(true);
    expect(gate.changed(before, session.status())).toBe(false);

    breach.armed = true;
    session.advance(5);
    breach.armed = false;

    // The world on screen is the last good one: same tick, nothing to re-read.
    expect(session.world().tick).toBe(before);
    const status = session.status();
    expect(status.held).toBe(false);
    expect(status.violations).toEqual(["section sec-x holds a and b"]);

    // The redraw gate opens although the tick did not change...
    expect(gate.changed(session.world().tick, status)).toBe(true);
    // ...and the indicator says BREACHED with the core's own text, not the stale reading.
    const reading = readInvariant(session.world(), session.index);
    expect(reading.held).toBe(true);
    const view = indicatorText({
      assertedHeld: status.held,
      assertedViolations: status.violations,
      reading,
      checkedTicks: status.checkedTicks,
    });
    expect(view.label).toBe("safety invariant: BREACHED");
    expect(view.detail).toBe("section sec-x holds a and b");

    // Latched: it never goes back to held and the simulation stays frozen.
    session.advance(20);
    expect(session.world().tick).toBe(before);
    expect(session.status().held).toBe(false);
    expect(gate.changed(session.world().tick, session.status())).toBe(false);
  });
});
