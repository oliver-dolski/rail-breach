import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSession, defenseCount } from "../../src/app/compare";
import { createAttractSession } from "../../src/app/session";
import { vendorVpn } from "../../src/content/scenarios";
import type { Comparison, Outcome } from "../../src/core/replay/counterfactual";
import type { Action } from "../../src/core/sim/actions";
import { compareRows, compareVerdict, createComparePanel } from "../../src/ui/panel/compare";

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  hash: "aaaaaaaa",
  firstActionTick: 100,
  detectedAt: 0,
  alerts: 0,
  blocked: 0,
  firstBlockedTick: 0,
  refused: 0,
  refusedByDefense: 0,
  compromised: ["corp-ws-dispatch", "dmz-relay", "tms-server"],
  commandChannelLost: ["tms-server"],
  signalsAtStop: 12,
  signals: 19,
  trainsStanding: 5,
  trains: 6,
  interlockingsDown: 0,
  ...over,
});

const held = (over: Partial<Outcome> = {}): Outcome =>
  outcome({
    hash: "bbbbbbbb",
    blocked: 1,
    firstBlockedTick: 150,
    compromised: ["corp-ws-dispatch"],
    commandChannelLost: [],
    signalsAtStop: 2,
    trainsStanding: 1,
    ...over,
  });

const both = (undefended: Outcome, defended: Outcome): Comparison => ({ undefended, defended });

describe("the comparison of a scenario with and without defenses", () => {
  it("lists the same rows for both runs: signals, trains, machines, detection", () => {
    const rows = compareRows(both(outcome(), held({ detectedAt: 200, alerts: 2 })), 1000);
    expect(rows.map((r) => r.label)).toEqual([
      "Signals at stop",
      "Trains standing",
      "Machines compromised",
      "Command channels lost",
      "Interlockings out of service",
      "Attack steps stopped at a boundary",
      "IDS alerts",
      "Time to detect",
    ]);
    const by = (label: string) => rows.find((r) => r.label === label);
    expect(by("Signals at stop")).toMatchObject({ without: "12 of 19", with: "2 of 19" });
    expect(by("Trains standing")).toMatchObject({ without: "5 of 6", with: "1 of 6" });
    expect(by("Machines compromised")).toMatchObject({ without: "3", with: "1" });
    expect(by("Command channels lost")).toMatchObject({ without: "1", with: "0" });
    expect(by("Time to detect")).toMatchObject({
      without: "not noticed, 90 s since the first action",
      with: "after 10 s",
    });
  });

  it("counts a launch refused at a boundary like a payload stopped in flight", () => {
    const rows = compareRows(both(outcome(), held({ blocked: 1, refusedByDefense: 3 })), 1000);
    expect(rows.find((r) => r.label === "Attack steps stopped at a boundary")).toMatchObject({
      without: "0",
      with: "4",
    });
  });

  it("says what the defenses changed, and only what they changed", () => {
    expect(compareVerdict(both(outcome(), held()))).toBe(
      "With the defenses: 2 fewer machines compromised, 1 fewer machine with the command channel lost, 10 fewer signals at stop, 4 fewer trains standing.",
    );
    expect(
      compareVerdict(both(outcome(), outcome({ hash: "cccccccc", alerts: 3, detectedAt: 120 }))),
    ).toBe("With the defenses: 3 more IDS alerts, the intruder is noticed.");
    expect(compareVerdict(both(outcome(), outcome({ hash: "dddddddd" })))).toMatch(
      /ends the same, but the run differs in detail/,
    );
  });

  it("does not invent an effect when both runs end the same", () => {
    expect(compareVerdict(both(outcome(), outcome()))).toBe(
      "The defenses changed nothing: both runs end in exactly the same state.",
    );
  });

  it("singular and plural are right", () => {
    const text = compareVerdict(
      both(outcome(), held({ compromised: ["a", "b"], commandChannelLost: ["tms-server"] })),
    );
    expect(text).toContain("1 fewer machine compromised");
  });
});

const firewall: Action = { type: "defense.place", kind: "firewall", on: { conduit: "c-dmz-ctrl" } };

describe("comparing a real session", () => {
  it("has nothing to compare while the session holds no defense at all", () => {
    const session = createAttractSession({ scenario: vendorVpn });
    session.advance(20);
    expect(defenseCount(session)).toBe(0);
    expect(compareSession(session)).toBeUndefined();
  });

  it("the phishing scenario's own sensors are enough to compare: the railway ends the same, the no-defense run sees fewer alerts", () => {
    const session = createAttractSession();
    // Pins a new expectation: the two recorded sensors count, so Compare is open from the start.
    expect(defenseCount(session)).toBe(2);
    const result = compareSession(session);
    expect(result).toBeDefined();
    const { undefended, defended } = result ?? { undefended: outcome(), defended: outcome() };
    expect(undefended.signalsAtStop).toBe(defended.signalsAtStop);
    expect(undefended.trainsStanding).toBe(defended.trainsStanding);
    expect(undefended.compromised).toEqual(defended.compromised);
    expect(undefended.alerts).toBeLessThan(defended.alerts);
  });

  it("runs the same scenario twice from the same world, to the end of the show, and the firewall makes the difference", () => {
    const session = createAttractSession();
    session.advance(20);
    session.dispatch(firewall);
    session.advance(10);
    expect(defenseCount(session)).toBe(3);

    const result = compareSession(session);
    expect(result).toBeDefined();
    const { undefended, defended } = result ?? { undefended: outcome(), defended: outcome() };
    // The run with no defense at all: the chain reaches the traffic management server.
    expect(undefended.commandChannelLost).toContain("tms-server");
    expect(undefended.compromised).toContain("tms-server");
    // With the firewall the same chain stops at the boundary.
    expect(defended.commandChannelLost).toEqual([]);
    expect(defended.compromised).not.toContain("tms-server");
    expect(defended.blocked + defended.refused).toBeGreaterThan(
      undefended.blocked + undefended.refused,
    );
    expect(defended.signalsAtStop).toBeLessThan(undefended.signalsAtStop);
    expect(defended.trainsStanding).toBeLessThanOrEqual(undefended.trainsStanding);
    expect(compareVerdict(result as Comparison)).toMatch(/^With the defenses: .*fewer/);

    // G-02-9: the refusals at the firewall are in the row the viewer reads.
    const row = compareRows(result as Comparison, 1000).find(
      (r) => r.label === "Attack steps stopped at a boundary",
    );
    expect(defended.refusedByDefense).toBeGreaterThan(0);
    expect(Number(row?.with)).toBeGreaterThan(0);
    expect(row?.with).toBe(String(defended.blocked + defended.refusedByDefense));
    expect(row?.without).toBe("0");
  });

  it("is deterministic and leaves the live session exactly where it was", () => {
    const session = createAttractSession();
    session.advance(20);
    session.dispatch(firewall);
    session.advance(10);
    const before = JSON.stringify(session.world());
    const a = compareSession(session);
    const b = compareSession(session);
    expect(b).toEqual(a);
    expect(JSON.stringify(session.world())).toBe(before);
    expect(session.live()).toBe(true);
  });

  it("switches off every defense, the scenario's sensors included", () => {
    const session = createAttractSession();
    session.advance(20);
    session.dispatch(firewall);
    const result = compareSession(session);
    // The run with no defense at all has no sensor to read the hops (and no baseline coverage).
    expect(result?.undefended.alerts).toBe(0);
  });

  it("starting over forgets the viewer's defenses and keeps the scenario's own", () => {
    const session = createAttractSession();
    session.dispatch(firewall);
    session.advance(10);
    session.reset();
    expect(defenseCount(session)).toBe(2);
    expect(compareSession(session)).toBeDefined();
  });
});

/** A small document for the panel: elements with children, text, attributes, a disabled flag and click handlers. */
function fakeDocument() {
  interface El {
    tag: string;
    attrs: Record<string, string>;
    children: El[];
    textContent: string;
    hidden: boolean;
    disabled: boolean;
    firstChild: El | undefined;
    append(...nodes: (El | string)[]): void;
    removeChild(child: El): void;
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, fn: () => void): void;
    click(): void;
  }
  const make = (tag: string): El => {
    const listeners: (() => void)[] = [];
    const el: El = {
      tag,
      attrs: {},
      children: [],
      textContent: "",
      hidden: false,
      disabled: false,
      get firstChild() {
        return el.children[0];
      },
      append(...nodes) {
        for (const n of nodes) {
          if (typeof n === "string") el.textContent += n;
          else el.children.push(n);
        }
      },
      removeChild(child) {
        el.children = el.children.filter((c) => c !== child);
      },
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      addEventListener(_type, fn) {
        listeners.push(fn);
      },
      click() {
        for (const fn of listeners) fn();
      },
    };
    Object.defineProperty(el, "innerHTML", {
      set() {
        throw new Error("innerHTML must not be used");
      },
    });
    return el;
  };
  const byId = new Map<string, El>();
  for (const id of [
    "compare-run",
    "compare-note",
    "compare-table",
    "compare-body",
    "compare-verdict",
  ]) {
    byId.set(id, make("div"));
  }
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: make,
  } as unknown as Document;
  return { doc, byId };
}

describe("the comparison on the page", () => {
  it("stays off until there is a defense, then shows both runs side by side and the verdict", () => {
    const { doc, byId } = fakeDocument();
    let count = 0;
    const panel = createComparePanel(doc, {
      defenseCount: () => count,
      run: () => (count === 0 ? undefined : both(outcome(), held())),
      endTick: () => 1000,
    });
    panel.update();
    expect(byId.get("compare-run")?.disabled).toBe(true);
    expect(byId.get("compare-note")?.textContent).toMatch(/Place a defense first/);

    count = 1;
    panel.update();
    expect(byId.get("compare-run")?.disabled).toBe(false);
    byId.get("compare-run")?.click();

    const rows = byId.get("compare-body")?.children ?? [];
    expect(rows).toHaveLength(8);
    const cells = rows[0]?.children.map((c) => c.textContent);
    expect(cells).toEqual(["Signals at stop", "12 of 19", "2 of 19"]);
    expect(byId.get("compare-table")?.hidden).toBe(false);
    expect(byId.get("compare-verdict")?.textContent).toMatch(/^With the defenses: /);
  });

  it("says when the result is out of date and forgets it on reset", () => {
    const { doc, byId } = fakeDocument();
    let count = 1;
    const panel = createComparePanel(doc, {
      defenseCount: () => count,
      run: () => both(outcome(), held()),
      endTick: () => 1000,
    });
    panel.update();
    byId.get("compare-run")?.click();
    count = 2;
    panel.update();
    expect(byId.get("compare-verdict")?.textContent).toMatch(/Out of date/);
    panel.reset();
    expect(byId.get("compare-table")?.hidden).toBe(true);
    expect(byId.get("compare-body")?.children).toEqual([]);
    expect(byId.get("compare-verdict")?.textContent).toBe("");
  });

  it("shows a failed run as a visible message and clears any older table", () => {
    const { doc, byId } = fakeDocument();
    let fail = false;
    const panel = createComparePanel(doc, {
      defenseCount: () => 1,
      run: () => {
        if (fail) throw new Error("section sec-x holds a and b");
        return both(outcome(), held());
      },
      endTick: () => 1000,
    });
    panel.update();
    byId.get("compare-run")?.click();
    expect(byId.get("compare-table")?.hidden).toBe(false);

    fail = true;
    byId.get("compare-run")?.click();
    expect(byId.get("compare-table")?.hidden).toBe(true);
    expect(byId.get("compare-body")?.children).toEqual([]);
    expect(byId.get("compare-verdict")?.textContent).toBe(
      "The comparison could not be completed: section sec-x holds a and b",
    );
  });

  it("holds no markup sink and only reads what the engine computed", () => {
    const code = readFileSync("src/ui/panel/compare.ts", "utf8");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
