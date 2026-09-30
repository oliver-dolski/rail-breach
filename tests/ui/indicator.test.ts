import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimEvent } from "../../src/core/sim/events";
import type { World } from "../../src/core/sim/world";
import {
  formatRefusal,
  groupDigits,
  type IndicatorElement,
  indicatorText,
  readInvariant,
  renderIndicator,
  renderRefusal,
} from "../../src/ui/panel/indicator";
import { networkIndex, run, scenario, warmWorld } from "../fixtures/attack";

const index = networkIndex();

/** An element that records what is done to it and refuses markup. */
function fakeElement(): IndicatorElement & { attrs: Record<string, string>; markup: string[] } {
  const attrs: Record<string, string> = {};
  const markup: string[] = [];
  return {
    textContent: "",
    attrs,
    markup,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    set innerHTML(value: string) {
      markup.push(value);
      throw new Error("innerHTML must not be used");
    },
  } as unknown as IndicatorElement & { attrs: Record<string, string>; markup: string[] };
}

type Rejected = Extract<SimEvent, { k: "command.rejected" }>;
const refusal = (over: Partial<Rejected> = {}): Rejected => ({
  k: "command.rejected",
  tick: 1,
  il: "IL-VEL",
  route: "R-VEL-dn-main",
  by: "ctc",
  reason: "conflicts with locked route R-L2-dn",
  ...over,
});

describe("the safety invariant indicator", () => {
  it("reads HELD from the core on the real world, at the start and after the attack has landed", () => {
    const start = warmWorld(index);
    expect(readInvariant(start, index)).toEqual({ held: true, violations: [] });

    const landed = run(start, index, scenario.actions, scenario.durationTicks).world;
    expect(readInvariant(landed, index).held).toBe(true);
  });

  it("would show a breach if the core reported one: two trains planted into one section", () => {
    const world = warmWorld(index);
    const train = world.trains[0];
    if (!train) throw new Error("no train to duplicate");
    const broken: World = { ...world, trains: [...world.trains, { ...train, id: "ghost" }] };
    const reading = readInvariant(broken, index);
    expect(reading.held).toBe(false);
    expect(reading.violations.join(" ")).toMatch(/holds/);

    const view = indicatorText({ assertedHeld: true, reading, checkedTicks: 10 });
    expect(view.held).toBe(false);
    expect(view.label).toBe("safety invariant: BREACHED");
    expect(view.label).not.toMatch(/HELD/);
  });

  it("does not flip back once a tick has failed the core's assertion", () => {
    const view = indicatorText({
      assertedHeld: false,
      reading: { held: true, violations: [] },
      checkedTicks: 99,
    });
    expect(view.held).toBe(false);
    expect(view.label).toContain("BREACHED");
  });

  it("writes the exact label, the tick count and a state attribute, through textContent only", () => {
    const label = fakeElement();
    const detail = fakeElement();
    renderIndicator(
      { label, detail },
      { assertedHeld: true, reading: { held: true, violations: [] }, checkedTicks: 7391 },
    );
    expect(label.textContent).toBe("safety invariant: HELD");
    expect(detail.textContent).toContain("7,391 ticks");
    expect(label.attrs["data-state"]).toBe("held");
    expect(label.markup).toEqual([]);
  });

  it("is present from the first paint and bound to the core, not a constant", () => {
    const first = indicatorText({
      assertedHeld: true,
      reading: { held: true, violations: [] },
      checkedTicks: 0,
    });
    const after = indicatorText({
      assertedHeld: true,
      reading: { held: false, violations: ["section sec-x holds a and b"] },
      checkedTicks: 0,
    });
    expect(first.label).not.toBe(after.label);
    expect(after.detail).toBe("section sec-x holds a and b");
  });

  it("groups digits by thousands", () => {
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1000)).toBe("1,000");
    expect(groupDigits(1234567)).toBe("1,234,567");
  });
});

describe("the refusal surface", () => {
  it("names the interlocking, the route and the reason in plain words", () => {
    expect(formatRefusal(refusal())).toBe(
      "IL-VEL refused route R-VEL-dn-main: conflicts with locked route R-L2-dn",
    );
    expect(formatRefusal(refusal({ il: "", route: "" }))).toBe(
      "The interlocking refused a command: conflicts with locked route R-L2-dn",
    );
  });

  it("writes a hostile reason as inert text, never as markup", () => {
    const text = fakeElement();
    const count = fakeElement();
    const hostile = "<img src=x onerror=alert(1)>";
    expect(() => renderRefusal({ text, count }, refusal({ reason: hostile }), 1234)).not.toThrow();
    expect(text.textContent).toContain(hostile);
    expect(text.markup).toEqual([]);
    expect(count.textContent).toBe("1,234 refused in this run");
  });

  it("says so while nothing has been refused yet", () => {
    const text = fakeElement();
    renderRefusal({ text, count: fakeElement() }, undefined, 0);
    expect(text.textContent).toMatch(/none yet/);
  });

  it("shows the refusal the real interlocking hands out once the command channel is blocked", () => {
    const landed = run(warmWorld(index), index, scenario.actions, scenario.durationTicks);
    const blocked = landed.events.filter(
      (e): e is Rejected => e.k === "command.rejected" && e.reason === "command channel is blocked",
    );
    expect(blocked.length).toBeGreaterThan(0);
    const first = blocked[0];
    if (!first) throw new Error("no refusal");
    expect(formatRefusal(first)).toMatch(
      /^IL-(TAV|VEL|CRE) refused route R-[\w-]+: command channel is blocked$/,
    );
  });
});

describe("what a screen reader is told", () => {
  const html = readFileSync("index.html", "utf8");

  it("announces only the verdict: the live region holds the label, not the running tick count", () => {
    const section = html.match(/<section class="indicator"[^>]*>/)?.[0] ?? "";
    expect(section).not.toMatch(/aria-live/);
    const label = html.match(/<div\s+id="indicator-label"[^>]*>/)?.[0] ?? "";
    expect(label).toMatch(/aria-live="polite"/);
    const detail = html.match(/<div\s+id="indicator-detail"[^>]*>/)?.[0] ?? "";
    expect(detail).not.toMatch(/aria-live/);
  });

  it("keeps the label text fixed while ticks pass, so the region only changes when the verdict flips", () => {
    const at = (ticks: number) =>
      indicatorText({
        assertedHeld: true,
        reading: { held: true, violations: [] },
        checkedTicks: ticks,
      });
    expect(at(10).label).toBe(at(99999).label);
    expect(at(10).detail).not.toBe(at(99999).detail);
  });
});
