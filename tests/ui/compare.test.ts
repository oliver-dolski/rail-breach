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
    // Pins a new expectation: held() also stops one attack step at a boundary, a changed row that now has its clause.
    expect(compareVerdict(both(outcome(), held()))).toBe(
      "With the defenses: 2 fewer machines compromised, 1 fewer machine with the command channel lost, 10 fewer signals at stop, 4 fewer trains standing, 1 more attack step stopped at a boundary.",
    );
    expect(
      compareVerdict(both(outcome(), outcome({ hash: "cccccccc", alerts: 3, detectedAt: 120 }))),
    ).toBe("With the defenses: 3 more IDS alerts, the intruder is noticed.");
  });

  it("says the table is the same when no figure differs, even though the hashes do", () => {
    // Pins a new expectation: it replaces the sentence that claimed a difference in detail.
    const text = compareVerdict(both(outcome(), outcome({ hash: "dddddddd" })));
    expect(text).toBe("Every figure in the table is the same with and without the defenses.");
    expect(text).not.toMatch(/in detail/);
  });

  it("has a clause for every row that changed, and none for a row that did not", () => {
    const same = outcome({ hash: "eeeeeeee" });
    const verdict = (over: Partial<Outcome>) =>
      compareVerdict(both(same, outcome({ hash: "ffffffff", ...over })));
    expect(verdict({ blocked: 2, refusedByDefense: 1 })).toBe(
      "With the defenses: 3 more attack steps stopped at a boundary.",
    );
    expect(verdict({ interlockingsDown: 1 })).toBe(
      "With the defenses: 1 more interlocking out of service.",
    );
    expect(verdict({ alerts: 1, detectedAt: 130 })).toBe(
      "With the defenses: 1 more IDS alert, the intruder is noticed.",
    );
    const noticed = (over: Partial<Outcome>) =>
      compareVerdict(
        both(
          outcome({ hash: "eeeeeeee", detectedAt: 200 }),
          outcome({ hash: "ffffffff", detectedAt: 200, ...over }),
        ),
      );
    expect(noticed({ detectedAt: 150 })).toBe(
      "With the defenses: the intruder is noticed 5 s sooner.",
    );
    expect(noticed({ detectedAt: 300 })).toBe(
      "With the defenses: the intruder is noticed 10 s later.",
    );
    expect(noticed({ detectedAt: 0 })).toBe("With the defenses: the intruder goes unnoticed.");
  });

  it("marks each row better, worse or same by its numbers", () => {
    const change = (u: Partial<Outcome>, d: Partial<Outcome>, label: string) =>
      compareRows(both(outcome(u), outcome({ hash: "9", ...d })), 1000).find(
        (r) => r.label === label,
      )?.change;
    // Fewer is better for the damage rows.
    expect(change({}, { signalsAtStop: 2 }, "Signals at stop")).toBe("better");
    expect(change({}, { signalsAtStop: 15 }, "Signals at stop")).toBe("worse");
    expect(change({}, {}, "Signals at stop")).toBe("same");
    expect(change({}, { trainsStanding: 1 }, "Trains standing")).toBe("better");
    expect(change({}, { compromised: [] }, "Machines compromised")).toBe("better");
    expect(change({}, { commandChannelLost: [] }, "Command channels lost")).toBe("better");
    expect(change({}, { interlockingsDown: 2 }, "Interlockings out of service")).toBe("worse");
    // More is better for what the defenses caught.
    expect(change({}, { blocked: 1 }, "Attack steps stopped at a boundary")).toBe("better");
    expect(
      change({ blocked: 2 }, { refusedByDefense: 1 }, "Attack steps stopped at a boundary"),
    ).toBe("worse");
    expect(change({}, { alerts: 2 }, "IDS alerts")).toBe("better");
    expect(change({ alerts: 2 }, {}, "IDS alerts")).toBe("worse");
    // Detected beats undetected, earlier beats later.
    expect(change({}, { detectedAt: 200 }, "Time to detect")).toBe("better");
    expect(change({ detectedAt: 200 }, {}, "Time to detect")).toBe("worse");
    expect(change({ detectedAt: 300 }, { detectedAt: 200 }, "Time to detect")).toBe("better");
    expect(change({ detectedAt: 200 }, { detectedAt: 300 }, "Time to detect")).toBe("worse");
    expect(change({ detectedAt: 200 }, { detectedAt: 200 }, "Time to detect")).toBe("same");
    expect(change({}, {}, "Time to detect")).toBe("same");
  });

  it("marks every row same when the figures are identical", () => {
    const rows = compareRows(both(outcome(), outcome({ hash: "dddddddd" })), 1000);
    expect(rows.every((r) => r.change === "same")).toBe(true);
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
    // The defended cell carries the row's change; the undefended one carries none.
    expect(rows[0]?.children[2]?.attrs["data-change"]).toBe("better");
    expect(rows[0]?.children[1]?.attrs["data-change"]).toBeUndefined();
    expect(rows.map((r) => r.children[2]?.attrs["data-change"])).toEqual([
      "better",
      "better",
      "better",
      "better",
      "same",
      "better",
      "same",
      "same",
    ]);
    expect(byId.get("compare-table")?.hidden).toBe(false);
    expect(byId.get("compare-verdict")?.textContent).toMatch(/^With the defenses: /);
  });

  it("marks a changed cell with a second cue besides the colour, and leaves an equal cell bare", () => {
    const { doc, byId } = fakeDocument();
    const panel = createComparePanel(doc, {
      defenseCount: () => 1,
      // IDS alerts and the interlockings row differ from the held() default: worse alerts, equal rest.
      run: () => both(outcome({ alerts: 4 }), held({ alerts: 1 })),
      endTick: () => 1000,
    });
    panel.update();
    byId.get("compare-run")?.click();
    const cell = (label: string) =>
      (byId.get("compare-body")?.children ?? []).find((r) => r.children[0]?.textContent === label)
        ?.children[2];

    // Better: a check mark hidden from assistive technology, the figure, and the words for it.
    const better = cell("Signals at stop");
    expect(better?.attrs["data-change"]).toBe("better");
    expect(
      better?.children.map((c) => [c.attrs.class, c.attrs["aria-hidden"], c.textContent]),
    ).toEqual([
      ["cue", "true", "✓"],
      ["visually-hidden", undefined, " (better with the defenses)"],
    ]);
    expect(better?.textContent).toBe("2 of 19");

    // Worse: the cross and the words for worse.
    const worse = cell("IDS alerts");
    expect(worse?.attrs["data-change"]).toBe("worse");
    expect(worse?.children.map((c) => c.textContent)).toEqual(["✗", " (worse with the defenses)"]);

    // Same: no marker element at all, only the figure.
    const same = cell("Interlockings out of service");
    expect(same?.attrs["data-change"]).toBe("same");
    expect(same?.children).toEqual([]);
    expect(same?.textContent).toBe("0");
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
