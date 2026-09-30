import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { stateHash } from "../../src/core/hash";
import { isAction } from "../../src/core/sim/actions";
import { cloneWorld, type World } from "../../src/core/sim/world";
import { NEUTRAL } from "../../src/render/palette";
import {
  buildView,
  createViewContext,
  type RenderView,
  reportingState,
} from "../../src/render/view";
import { networkIndex, nodeOf, run, warmWorld } from "../fixtures/attack";

const index = networkIndex();
const ctx = createViewContext(network, index, layout);
const warm = () => warmWorld(index);

/** Recursively freezes a world, so any write by the code under test throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The warm world after the intruder, holding tms-server, has launched `technique` at console 1. */
function attackedWorld(technique: string): World {
  for (let seed = 0; seed < 60; seed++) {
    const start = cloneWorld(warm());
    start.seed = seed;
    nodeOf(start, "tms-server").integrity = 1;
    const launch = {
      t: start.tick + 1,
      a: { type: "technique.launch" as const, technique, target: "dispatch-hmi-1" },
    };
    const { world } = run(start, index, [launch], start.tick + 300);
    if (reportingState(world) !== "ok") return world;
  }
  throw new Error(`no seed lets ${technique} land`);
}

const occupiedLines = (view: RenderView) =>
  view.track.filter((line) => line.color[0] === NEUTRAL.trackOccupied[0] && line.color[3] === 1)
    .length;

describe("operator view against ground truth", () => {
  it("matches ground truth exactly on a railway nobody has attacked", () => {
    const world = warm();
    expect(world.trains.length).toBeGreaterThan(0);
    expect(reportingState(world)).toBe("ok");
    const truth = buildView(world, ctx, { mode: "ground-truth" });
    const operator = buildView(world, ctx, { mode: "operator" });
    expect({ ...operator, mode: "ground-truth" }).toEqual(truth);
  });

  it("shows a false all-clear while a spoofed report is fed to the consoles", () => {
    const world = attackedWorld("T1692.002");
    expect(reportingState(world)).toBe("spoofed");
    expect(world.trains.length).toBeGreaterThan(0);

    const truth = buildView(world, ctx, { mode: "ground-truth" });
    const operator = buildView(world, ctx, { mode: "operator" });

    expect(truth.trainsShown).toBe(world.trains.length);
    expect(operator.trainsShown).toBe(0);
    // A section the operator sees clear is occupied in ground truth.
    expect(occupiedLines(truth)).toBeGreaterThan(0);
    expect(occupiedLines(operator)).toBe(0);
    expect(operator.track).not.toEqual(truth.track);
    // The counts still describe the real railway, so the panel never prints a spoofed number.
    expect(operator.stats).toEqual(truth.stats);
    // The vital layer is not spoofed: signals and set routes are the same in both pictures.
    expect(operator.signals).toEqual(truth.signals);
    expect(operator.routes).toEqual(truth.routes);
  });

  it("keeps showing the last good picture, dimmed and standing still, on a frozen console", () => {
    const before = warm();
    const world = attackedWorld("T0829");
    expect(reportingState(world)).toBe("frozen");

    const truth = buildView(world, ctx, { mode: "ground-truth" });
    const operator = buildView(world, ctx, { mode: "operator", lastGood: before });

    expect(operator.trainsShown).toBe(before.trains.length);
    expect(operator.trains).not.toEqual(truth.trains);
    // Drawn where the snapshot left them: the same as a ground-truth view of that snapshot, but dim.
    const then = buildView(before, ctx, { mode: "ground-truth" });
    expect(operator.trains.map((t) => [t.x0, t.y0, t.x1, t.y1])).toEqual(
      then.trains.map((t) => [t.x0, t.y0, t.x1, t.y1]),
    );
    for (const train of operator.trains) expect(train.color[3]).toBeLessThan(1);
  });

  it("draws a frozen console with no snapshot to show, and a blank one, as unknown", () => {
    const frozen = attackedWorld("T0829");
    const unknown = buildView(frozen, ctx, { mode: "operator" });
    expect(unknown.trainsShown).toBe(0);
    expect(occupiedLines(unknown)).toBe(0);

    const blank = cloneWorld(frozen);
    nodeOf(blank, "tms-server").view = "blank";
    const blanked = buildView(blank, ctx, { mode: "operator", lastGood: warm() });
    expect(blanked.reporting).toBe("blank");
    expect(blanked.trainsShown).toBe(0);
    expect(blanked.track).toEqual(unknown.track);
  });

  it("ignores a snapshot from the future and never shows it", () => {
    const frozen = attackedWorld("T0829");
    const future = cloneWorld(frozen);
    future.tick += 50;
    const view = buildView(frozen, ctx, { mode: "operator", lastGood: future });
    expect(view.trainsShown).toBe(0);
  });

  it("is derived purely: two builds from one snapshot are equal and the world is never written", () => {
    for (const technique of ["T1692.002", "T0829"]) {
      const world = attackedWorld(technique);
      const before = warm();
      const hash = stateHash(world);
      deepFreeze(world);
      deepFreeze(before);
      for (const mode of ["ground-truth", "operator"] as const) {
        const opts = { mode, lastGood: before };
        const a = buildView(world, ctx, opts);
        const b = buildView(world, ctx, opts);
        expect(b).toEqual(a);
        expect(stateHash(world)).toBe(hash);
      }
    }
  });

  it("reads the feed from the supervisory machines only", () => {
    const world = cloneWorld(warm());
    nodeOf(world, "oc-tav").view = "spoofed";
    expect(reportingState(world)).toBe("ok");
    nodeOf(world, "dispatch-hmi-2").view = "spoofed";
    expect(reportingState(world)).toBe("spoofed");
    nodeOf(world, "tms-server").view = "frozen";
    expect(reportingState(world)).toBe("frozen");
  });
});

describe("the toggle is the page's own business", () => {
  it("is not an action, so no recording can carry it", () => {
    for (const type of ["view.toggle", "view.set", "operator-view"]) {
      expect(isAction({ type, mode: "operator" })).toBe(false);
    }
  });

  it("lives in a module that cannot reach the engine, a recording or the session", () => {
    const code = readFileSync("src/ui/panel/viewmode.ts", "utf8");
    expect(code).not.toMatch(/^import (?!type)[^\n]*from "(\.\.\/)+(core|app)\//m);
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
