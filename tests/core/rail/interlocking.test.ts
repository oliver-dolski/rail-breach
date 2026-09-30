import { describe, expect, it } from "vitest";
import { deriveRailInputs, neutralInputs } from "../../../src/core/rail/inputs";
import { deriveAspect, stepInterlocking } from "../../../src/core/rail/interlocking";
import type { Action } from "../../../src/core/sim/actions";
import type { SimEvent } from "../../../src/core/sim/events";
import { buildIndex, type Index } from "../../../src/core/sim/model";
import { step } from "../../../src/core/sim/step";
import { createWorld, type World } from "../../../src/core/sim/world";
import { miniRail } from "../../fixtures/mini-rail";

const SEED = 7;

function fresh(): { world: World; index: Index } {
  return { world: createWorld(miniRail, SEED), index: buildIndex(miniRail) };
}

/** Steps n ticks, feeding `actions` at the ticks they are keyed by. */
function run(
  world: World,
  index: Index,
  n: number,
  actions: Record<number, Action[]> = {},
  onTick?: (world: World, events: SimEvent[]) => void,
): { world: World; events: SimEvent[] } {
  let current = world;
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const result = step(current, actions[current.tick + 1] ?? [], index);
    current = result.world;
    all.push(...result.events);
    onTick?.(current, result.events);
  }
  return { world: current, events: all };
}

function signal(index: Index, id: string) {
  const found = index.rail.graph.signalById.get(id);
  if (!found) throw new Error(`no signal ${id}`);
  return found;
}

describe("deriveAspect", () => {
  it("shows proceed for a proved locked route whose next signal also has a route", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push(
      { route: "R-A", used: false },
      { route: "R-B", used: false },
    );
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("proceed");
    expect(deriveAspect(signal(index, "S-B"), world, index)).toBe("proceed");
  });

  it("shows caution when the route is proved but the next signal is at stop", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push({ route: "R-A", used: false });
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("caution");
  });

  it("shows stop when no route is locked", () => {
    const { world, index } = fresh();
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("stop");
  });

  it("shows stop once the route is no longer proved, without any lock being touched", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push({ route: "R-A", used: false });
    world.disturbed = ["sec-B"];
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("stop");
  });

  it("shows stop for a route already in use by a train", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push({ route: "R-A", used: true });
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("stop");
  });

  it("derives dark for every signal of an interlocking that is down", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push(
      { route: "R-A", used: false },
      { route: "R-B", used: false },
    );
    const inputs = neutralInputs(world);
    inputs.interlockingHealth["IL-1"] = "down";
    stepInterlocking(world, index, [], inputs);
    for (const s of index.rail.graph.signals) {
      expect(deriveAspect(s, world, index), s.id).toBe("dark");
    }
  });

  it("returns to proceed when the interlocking recovers and the held lock is still proved", () => {
    const { world, index } = fresh();
    world.interlockings[0]?.locks.push(
      { route: "R-A", used: false },
      { route: "R-B", used: false },
    );
    const down = neutralInputs(world);
    down.interlockingHealth["IL-1"] = "down";
    stepInterlocking(world, index, [], down);
    stepInterlocking(world, index, [], neutralInputs(world));
    expect(deriveAspect(signal(index, "S-A"), world, index)).toBe("proceed");
  });
});

describe("deriveRailInputs", () => {
  it("is neutral when no node carries a cyber effect", () => {
    const { world, index } = fresh();
    expect(deriveRailInputs(world, index)).toEqual(neutralInputs(world));
  });

  it("maps a downed interlocking node to health down and a blocked channel to cmdBlocked", () => {
    const { world, index } = fresh();
    const il = world.nodes.find((n) => n.id === "il-1-ctl");
    if (!il) throw new Error("fixture broken");
    il.availability = "down";
    il.cmdBlocked = true;
    const inputs = deriveRailInputs(world, index);
    expect(inputs.interlockingHealth["IL-1"]).toBe("down");
    expect(inputs.cmdBlocked["IL-1"]).toBe(true);
  });

  it("maps a failed object controller to dark signals and disturbed sections", () => {
    const { world, index } = fresh();
    const oc = world.nodes.find((n) => n.id === "oc-1");
    if (!oc) throw new Error("fixture broken");
    oc.availability = "down";
    const inputs = deriveRailInputs(world, index);
    expect(inputs.darkSignals).toEqual(["S-A", "S-B"]);
    expect(inputs.disturbedSections).toEqual(["sec-A", "sec-B", "sec-C"]);
  });

  it("never reports a healthier state than neutral, whatever the node state", () => {
    const { world, index } = fresh();
    const neutral = neutralInputs(world);
    const availabilities = ["ok", "degraded", "down"] as const;
    const views = ["ok", "frozen", "blank", "spoofed"] as const;
    for (const availability of availabilities) {
      for (const view of views) {
        for (const flag of [false, true]) {
          for (const node of world.nodes) {
            node.availability = availability;
            node.view = view;
            node.cmdBlocked = flag;
            node.controlDenied = flag;
            node.integrity = flag ? 2 : 0;
          }
          const inputs = deriveRailInputs(world, index);
          for (const id of Object.keys(neutral.interlockingHealth)) {
            expect(["ok", "down"]).toContain(inputs.interlockingHealth[id]);
          }
          expect(inputs.paramClamps).toEqual({});
          if (availability === "ok" && view === "ok" && !flag) {
            expect(inputs).toEqual(neutral);
          }
        }
      }
    }
  });
});

function node(world: World, id: string) {
  const found = world.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("a train meeting a signal", () => {
  it("brakes and halts at or before a signal at stop, never past it", () => {
    const { world, index } = fresh();
    // With the command channel shut the dispatch layer cannot set S-A's route.
    node(world, "il-1-ctl").cmdBlocked = true;
    const posOfSignal = index.rail.graph.services.get("SV-1")?.sigs[0]?.posDm ?? -1;
    expect(posOfSignal).toBe(signal(index, "S-A").atDm);

    let peak = 0;
    const { world: end, events } = run(world, index, 1500, {}, (w) => {
      const train = w.trains[0];
      if (train) peak = Math.max(peak, train.posDm);
    });
    const train = end.trains[0];
    expect(train?.speedDmPerTick).toBe(0);
    expect(train?.posDm).toBeGreaterThan(posOfSignal - 200);
    expect(peak).toBeLessThanOrEqual(posOfSignal);
    expect(events.some((e) => e.k === "train.stopped" && e.cause === "signal")).toBe(true);
    expect(events.some((e) => e.k === "train.overran")).toBe(false);
    expect(events.some((e) => e.k === "command.rejected" && e.reason.includes("blocked"))).toBe(
      true,
    );
  });

  it("runs the whole segment when the dispatch layer is free to set routes", () => {
    const { world, index } = fresh();
    const { events } = run(world, index, 4000);
    expect(events.filter((e) => e.k === "route.set").map((e) => e.route)).toEqual(["R-A", "R-B"]);
    expect(events.some((e) => e.k === "train.arrived")).toBe(true);
    expect(events.some((e) => e.k === "train.overran")).toBe(false);
  });

  it("halts at the second signal when the channel closes after the first is passed", () => {
    const { world, index } = fresh();
    const second = 17000;
    let current = world;
    while ((current.trains[0]?.sig ?? 0) < 1) current = run(current, index, 1).world;
    node(current, "il-1-ctl").cmdBlocked = true;
    const { world: end } = run(current, index, 2500, {}, (w) => {
      expect(w.trains[0]?.posDm ?? 0).toBeLessThanOrEqual(second);
    });
    const train = end.trains[0];
    expect(train?.posDm).toBeGreaterThan(second - 200);
    expect(train?.speedDmPerTick).toBe(0);
  });

  it("stops for a signal that goes dark while the train is still far away", () => {
    const { world, index } = fresh();
    let current = run(world, index, 400).world;
    expect(current.trains[0]?.sig).toBe(1);
    node(current, "il-1-ctl").availability = "down";
    const before = current.trains[0]?.posDm ?? 0;
    current = run(current, index, 1500, {}, (w) => {
      expect(w.trains[0]?.posDm ?? 0).toBeLessThanOrEqual(17000);
    }).world;
    const train = current.trains[0];
    expect(train?.posDm).toBeGreaterThan(before);
    expect(train?.speedDmPerTick).toBe(0);
    expect(train?.overrun).toBe(-1);
  });
});

describe("step without an index", () => {
  it("still advances the cyber side only", () => {
    const world = createWorld(miniRail, SEED);
    expect(step(world, []).world.tick).toBe(1);
  });
});
