import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { techniques } from "../../src/content/techniques";
import type { SimEvent } from "../../src/core/sim/events";
import { createNames, EventLog } from "../../src/ui/panel/log";
import { createTimelineView, Timeline } from "../../src/ui/panel/timeline";

const names = createNames(layout, techniques);
const START = 100;
const LENGTH = 1000;

const started = (tick: number, technique: string, target: string, op = 1): SimEvent => ({
  k: "op.started",
  tick,
  op,
  technique,
  target,
  from: "internet",
});
const applied = (tick: number, technique: string, node: string, effect: string): SimEvent =>
  ({ k: "effect.applied", tick, op: 1, technique, node, effect }) as SimEvent;
const alert = (
  tick: number,
  technique = "T0886",
  link = "l-dmz-hmi1",
  conduit = "c-dmz-ctrl",
): SimEvent => ({
  k: "ids.alert",
  tick,
  op: 1,
  technique,
  legacyId: "",
  link,
  conduit,
  sensor: "baseline",
});

/** The synthetic run of the brief: attacker actions, then one detection. */
const stream = (): SimEvent[] => [
  started(150, "T0865", "corp-ws-dispatch", 1),
  applied(180, "T0865", "corp-ws-dispatch", "foothold"),
  started(200, "T0886", "dmz-relay", 2),
  applied(260, "T0886", "tms-server", "blockCommands"),
  alert(300),
];

describe("the two-lane timeline", () => {
  it("puts attacker actions and detections on separate lanes, each in tick order", () => {
    const tl = new Timeline(names);
    // Delivered in two batches and out of order on purpose: the lane sorts by tick.
    tl.ingest(stream().slice(3), START);
    tl.ingest(stream().slice(0, 3), START);
    const model = tl.model({ tick: 400, firstActionTick: 150, detectedAt: 300 }, START, LENGTH);

    expect(model.attacker.map((m) => m.tick)).toEqual([50, 100, 160]);
    expect(model.attacker.map((m) => m.kind)).toEqual(["launch", "launch", "impact"]);
    expect(model.attacker.every((m) => m.lane === "attacker")).toBe(true);
    expect(model.detection.map((m) => m.tick)).toEqual([200]);
    expect(model.detection.map((m) => m.kind)).toEqual(["alert"]);
    expect(model.detection.every((m) => m.lane === "detection")).toBe(true);
    expect(model.attacker.map((m) => m.permille)).toEqual([50, 100, 160]);
  });

  it("shades the dwell from the first action to the first detection: detectedAt minus firstActionTick", () => {
    const tl = new Timeline(names);
    tl.ingest(stream(), START);
    const { dwell } = tl.model({ tick: 400, firstActionTick: 150, detectedAt: 300 }, START, LENGTH);
    expect(dwell).toMatchObject({ fromTick: 150, toTick: 300, ticks: 150, open: false });
    expect(dwell?.fromPermille).toBe(50);
    expect(dwell?.toPermille).toBe(200);
  });

  it("keeps the dwell open and growing while nothing has been noticed", () => {
    const tl = new Timeline(names);
    tl.ingest(stream().slice(0, 4), START);
    const at = (tick: number) =>
      tl.model({ tick, firstActionTick: 150, detectedAt: 0 }, START, LENGTH).dwell;
    expect(at(300)).toMatchObject({ open: true, ticks: 150 });
    expect(at(500)).toMatchObject({ open: true, ticks: 350 });
  });

  it("has no dwell before the attacker acts, and only the quiet effects are left off the lane", () => {
    const tl = new Timeline(names);
    tl.ingest([applied(120, "T0865", "corp-ws-dispatch", "foothold")], START);
    const model = tl.model({ tick: 130, firstActionTick: 0, detectedAt: 0 }, START, LENGTH);
    expect(model.dwell).toBeUndefined();
    expect(model.attacker).toEqual([]);
    expect(model.nowPermille).toBe(30);
  });

  it("tags each mark with the technique, current id and the pre-v19 one", () => {
    const tl = new Timeline(names);
    tl.ingest([started(150, "T1692.002", "dispatch-hmi-1"), alert(160, "T1692.002")], START);
    const model = tl.model({ tick: 200, firstActionTick: 150, detectedAt: 160 }, START, LENGTH);
    expect(model.attacker[0]?.technique).toBe("T1692.002 (was T0856)");
    expect(model.attacker[0]?.label).toContain("T1692.002 (was T0856)");
    expect(model.detection[0]?.label).toContain("T1692.002 (was T0856)");
  });

  it("marks an assumed breach on the attacker lane and forgets everything on reset", () => {
    const tl = new Timeline(names);
    tl.ingest([{ k: "breach.assumed", tick: START, node: "mws-vel" }], START);
    const world = { tick: START, firstActionTick: 0, detectedAt: 0 };
    expect(tl.model(world, START, LENGTH).attacker).toEqual([
      expect.objectContaining({ kind: "breach", tick: 0 }),
    ]);
    tl.reset();
    expect(tl.model(world, START, LENGTH).attacker).toEqual([]);
  });

  it("keeps every mark inside the lane, however early or late the event", () => {
    const tl = new Timeline(names);
    tl.ingest([started(START - 500, "T0865", "corp-ws-dispatch"), alert(START + 9000)], START);
    const model = tl.model({ tick: START, firstActionTick: 0, detectedAt: 0 }, START, LENGTH);
    expect(model.attacker[0]?.permille).toBe(0);
    expect(model.detection[0]?.permille).toBe(1000);
  });
});

/** A small document: elements with attributes, children, a style object and text, and a trap on markup. */
function fakeDocument() {
  interface El {
    tag: string;
    attrs: Record<string, string>;
    children: El[];
    style: Record<string, string>;
    hidden: boolean;
    textContent: string;
    parent?: El;
    setAttribute(name: string, value: string): void;
    append(...nodes: (El | string)[]): void;
    remove(): void;
  }
  const make = (tag: string): El => {
    const el: El = {
      tag,
      attrs: {},
      children: [],
      style: {},
      hidden: false,
      textContent: "",
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (typeof n === "string") el.textContent += n;
          else {
            n.parent = el;
            el.children.push(n);
          }
        }
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
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
    "tl-attacker",
    "tl-detection",
    "tl-dwell",
    "tl-now-attacker",
    "tl-now-detection",
    "tl-band-attacker",
    "tl-band-detection",
  ]) {
    byId.set(id, make("div"));
  }
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: make,
  } as unknown as Document;
  return { doc, byId };
}

describe("the timeline on the page", () => {
  const world = { tick: 400, firstActionTick: 150, detectedAt: 300 };

  it("draws attackers and detections on distinct lanes in distinct tones", () => {
    const { doc, byId } = fakeDocument();
    const view = createTimelineView(doc);
    const tl = new Timeline(names);
    tl.ingest(stream(), START);
    view.update(tl.model(world, START, LENGTH), world);

    const attacker = byId.get("tl-attacker")?.children ?? [];
    const detection = byId.get("tl-detection")?.children ?? [];
    expect(attacker.map((e) => e.attrs.class)).toEqual([
      "tl-mark tl-launch",
      "tl-mark tl-launch",
      "tl-mark tl-impact",
    ]);
    expect(detection.map((e) => e.attrs.class)).toEqual(["tl-mark tl-alert"]);
    expect(attacker.map((e) => e.style.left)).toEqual(["5%", "10%", "16%"]);
    expect(byId.get("tl-band-attacker")?.style.width).toBe("15%");
    expect(byId.get("tl-band-detection")?.hidden).toBe(false);
    expect(byId.get("tl-dwell")?.textContent).toBe("Time to detect: after 15 s");
  });

  it("writes a hostile string from an event field as inert text, never as markup", () => {
    const hostile = `<img src=x onerror="window.__pwned=1"><script>alert(1)</script>`;
    const { doc, byId } = fakeDocument();
    const view = createTimelineView(doc);
    const tl = new Timeline(names);
    // The link of an alert with no conduit is shown as given.
    tl.ingest([alert(200, "T0886", hostile, "")], START);
    const w = { tick: 300, firstActionTick: 150, detectedAt: 200 };
    view.update(tl.model(w, START, LENGTH), w);
    const mark = byId.get("tl-detection")?.children[0];
    expect(mark?.attrs.title).toContain(hostile);
    expect(mark?.attrs["aria-label"]).toContain(hostile);
    expect(mark?.children).toEqual([]);
    expect(mark?.textContent).toBe("");
  });

  it("leaves a mark alone on a frame that changes nothing and removes it when it is gone", () => {
    const { doc, byId } = fakeDocument();
    const view = createTimelineView(doc);
    const tl = new Timeline(names);
    tl.ingest(stream(), START);
    view.update(tl.model(world, START, LENGTH), world);
    const first = byId.get("tl-attacker")?.children[0];
    view.update(tl.model(world, START, LENGTH), world);
    expect(byId.get("tl-attacker")?.children[0]).toBe(first);
    tl.reset();
    const quiet = { tick: 400, firstActionTick: 0, detectedAt: 0 };
    view.update(tl.model(quiet, START, LENGTH), quiet);
    expect(byId.get("tl-attacker")?.children.length).toBe(0);
    expect(byId.get("tl-detection")?.children.length).toBe(0);
    expect(byId.get("tl-band-attacker")?.hidden).toBe(true);
  });

  it("does not reuse a mark element for a different mark after a scenario switch", () => {
    const { doc, byId } = fakeDocument();
    const view = createTimelineView(doc);
    const tl = new Timeline(names);
    tl.ingest([started(150, "T0865", "corp-ws-dispatch")], START);
    view.update(tl.model(world, START, LENGTH), world);
    const old = byId.get("tl-attacker")?.children[0];
    tl.reset();
    tl.ingest([{ k: "breach.assumed", tick: START, node: "mws-vel" }], START);
    view.update(tl.model(world, START, LENGTH), world);

    const marks = byId.get("tl-attacker")?.children ?? [];
    expect(marks.length).toBe(1);
    expect(marks[0]).not.toBe(old);
    expect(marks[0]?.attrs.class).toBe("tl-mark tl-breach");
    expect(marks[0]?.attrs.title).toContain("Assumed breach");
  });

  it("is a reader of events and snapshots: no markup sink and no engine import in its source", () => {
    const code = readFileSync("src/ui/panel/timeline.ts", "utf8");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/^import (?!type)[^\n]*from "(\.\.\/)+core\//m);
  });
});

describe("the event log's two lanes", () => {
  const sim = (tick: number, i: number): SimEvent => ({
    k: "train.stopped",
    tick,
    train: `T${i}`,
    cause: "signal",
    signal: "S-X",
  });

  it("keeps simulation events and IDS alerts on separate lists with separate tones", () => {
    const log = new EventLog(names);
    log.ingest([started(150, "T0865", "corp-ws-dispatch"), alert(160), sim(170, 1)], START);
    expect(log.simulation().map((e) => e.tone)).toEqual(["rail", "attack"]);
    expect(log.alerts().map((e) => e.tone)).toEqual(["detection"]);
    expect(log.alerts()[0]?.text).toContain("IDS alert");
    expect(log.entries()).toHaveLength(3);
  });

  it("never lets a flood of simulation events push an alert out", () => {
    const log = new EventLog(names, 5, 3);
    log.ingest([alert(120)], START);
    log.ingest(
      Array.from({ length: 40 }, (_, i) => sim(130 + i, i)),
      START,
    );
    expect(log.simulation()).toHaveLength(5);
    expect(log.alerts()).toHaveLength(1);
    log.ingest([alert(200), alert(210), alert(220), alert(230)], START);
    expect(log.alerts()).toHaveLength(3);
    expect(log.simulation()).toHaveLength(5);
  });

  it("keeps ordinary queueing refusals out of both lists", () => {
    const log = new EventLog(names);
    log.ingest(
      Array.from({ length: 30 }, (_, i) => ({
        k: "command.rejected" as const,
        tick: 200 + i,
        il: "IL-VEL",
        route: "R",
        by: "ctc",
        reason: "conflicts with locked route R-L2-dn",
      })),
      START,
    );
    expect(log.entries()).toEqual([]);
  });

  it("says in words when operators regain control, next to when they lost it", () => {
    const log = new EventLog(names);
    log.ingest(
      [
        applied(200, "T0813", "tms-server", "denyControl"),
        { k: "effect.cleared", tick: 1400, node: "tms-server", effect: "denyControl" },
      ],
      START,
    );
    const lines = log.simulation().map((e) => e.text);
    expect(lines[0]).toMatch(/Traffic mgmt: operators regained control$/);
    expect(lines[1]).toMatch(/Traffic mgmt: operators lost control$/);
  });

  it("words every other cleared effect and an assumed breach readably", () => {
    const log = new EventLog(names);
    const cleared = (effect: string): SimEvent =>
      ({ k: "effect.cleared", tick: 500, node: "il-vel", effect }) as SimEvent;
    log.ingest(
      [
        cleared("setView"),
        cleared("degrade"),
        cleared("blockCommands"),
        cleared("clampParam"),
        { k: "breach.assumed", tick: START, node: "mws-vel" },
      ],
      START,
    );
    const text = log
      .simulation()
      .map((e) => e.text)
      .join("\n");
    expect(text).toContain("operators' picture restored");
    expect(text).toContain("back in service");
    expect(text).toContain("command channel restored");
    expect(text).toContain("speed limit restored");
    expect(text).toContain("already held by the intruder (assumed breach)");
  });
});
