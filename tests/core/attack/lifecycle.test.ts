import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { applyEffect } from "../../../src/core/attack/effects";
import { stateHash } from "../../../src/core/hash";
import { deriveRailInputs } from "../../../src/core/rail/inputs";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import { assertRecording, type TimedAction } from "../../../src/core/replay/recording";
import { isAction } from "../../../src/core/sim/actions";
import { DENIAL_OF_CONTROL_RECOVER_TICKS } from "../../../src/core/sim/constants";
import type { SimEvent } from "../../../src/core/sim/events";
import { createWorld, type TrainState, type World } from "../../../src/core/sim/world";
import recordingJson from "../../../src/recordings/phishing-dispatcher.json";
import { networkIndex, nodeOf, run } from "../../fixtures/attack";

// The index checks the safety invariant after every step, so every run below
// asserts it on every tick: a violation throws out of step().
const index = networkIndex();

const SEEDS = Array.from({ length: 40 }, (_, i) => i);

const roundTrip = (world: World): World => JSON.parse(JSON.stringify(world)) as World;

interface Launch {
  technique: string;
  target: string;
  foothold: string[];
  discovered: string[];
}

const T0813: Launch = {
  technique: "T0813",
  target: "dispatch-hmi-2",
  foothold: ["tms-server"],
  discovered: [],
};

function prepared(launch: Launch, seed: number): World {
  const world = createWorld(network, seed);
  for (const id of launch.foothold) nodeOf(world, id).integrity = 1;
  for (const id of launch.discovered) nodeOf(world, id).discovered = true;
  return world;
}

const launchAction = (launch: Launch, t = 1): TimedAction => ({
  t,
  a: { type: "technique.launch", technique: launch.technique, target: launch.target },
});

/** The first seed whose dice let the launch succeed, found by running it. */
function winningSeed(launch: Launch, effect: string): number {
  for (const seed of SEEDS) {
    const { events } = run(prepared(launch, seed), index, [launchAction(launch)], 400);
    if (events.some((e) => e.k === "effect.applied" && e.effect === effect)) return seed;
  }
  throw new Error(`no seed lets ${launch.technique} succeed`);
}

const cleared = (events: SimEvent[]) =>
  events.filter((e): e is Extract<SimEvent, { k: "effect.cleared" }> => e.k === "effect.cleared");

describe("T0813 Denial of Control lifts on its own", () => {
  const seed = winningSeed(T0813, "denyControl");
  const actions = [launchAction(T0813)];

  const landing = run(prepared(T0813, seed), index, actions, 400);
  const landedAt = landing.events.find(
    (e) => e.k === "effect.applied" && e.effect === "denyControl",
  )?.tick;

  it("lands, is held for the recovery period and lifts on the exact tick", () => {
    expect(landedAt).toBeDefined();
    if (landedAt === undefined) return;
    const recoverAt = landedAt + DENIAL_OF_CONTROL_RECOVER_TICKS;

    const hmi = nodeOf(landing.world, T0813.target);
    expect(hmi.controlDenied).toBe(true);
    expect(hmi.controlRecoverAt).toBe(recoverAt);

    // One tick short of the end the operators are still locked out, with no event yet.
    const before = run(landing.world, index, actions, recoverAt - 1);
    expect(nodeOf(before.world, T0813.target).controlDenied).toBe(true);
    expect(cleared(before.events)).toEqual([]);

    // The tick after brings control back and says so, once.
    const at = run(before.world, index, actions, recoverAt);
    const node = nodeOf(at.world, T0813.target);
    expect(node.controlDenied).toBe(false);
    expect(node.controlRecoverAt).toBe(0);
    expect(cleared(at.events)).toEqual([
      { k: "effect.cleared", tick: recoverAt, node: T0813.target, effect: "denyControl" },
    ]);

    // It stays lifted: nothing re-applies it.
    const later = run(at.world, index, actions, recoverAt + 300);
    expect(nodeOf(later.world, T0813.target).controlDenied).toBe(false);
    expect(cleared(later.events)).toEqual([]);
  });

  it("reaches the same world in one long advance and in short chunks with a JSON round-trip", () => {
    const TOTAL = 1500; // past landing plus the 1200-tick recovery period
    const start = prepared(T0813, seed);
    const whole = run(start, index, actions, TOTAL);

    let chunked = start;
    const chunkedEvents: SimEvent[] = [];
    for (let from = 0; from < TOTAL; from += 100) {
      const part = run(chunked, index, actions, from + 100);
      chunkedEvents.push(...part.events);
      chunked = roundTrip(part.world);
    }

    expect(cleared(whole.events)).toHaveLength(1);
    expect(nodeOf(whole.world, T0813.target).controlDenied).toBe(false);
    expect(stateHash(chunked)).toBe(stateHash(whole.world));
    expect(chunkedEvents).toEqual(whole.events);
  });

  it("does not shorten a denial that has no end of its own", () => {
    const world = prepared(T0813, seed);
    const hmi = nodeOf(world, T0813.target);
    hmi.controlDenied = true;
    hmi.controlRecoverAt = 0;
    const result = run(world, index, [], DENIAL_OF_CONTROL_RECOVER_TICKS + 50);
    expect(nodeOf(result.world, T0813.target).controlDenied).toBe(true);
    expect(cleared(result.events)).toEqual([]);
  });
});

const restoreAction = (t: number, node: string): TimedAction => ({
  t,
  a: { type: "restore", node },
});

describe("T0829 Loss of View persists until a local restoration", () => {
  const T0829: Launch = {
    technique: "T0829",
    target: "tms-server",
    foothold: ["dispatch-hmi-1"],
    discovered: [],
  };
  const seed = winningSeed(T0829, "setView");
  const actions = [launchAction(T0829)];
  const landing = run(prepared(T0829, seed), index, actions, 400);

  it("does not clear by time: still not ok 1000 ticks later, and only the restore brings it back", () => {
    expect(nodeOf(landing.world, T0829.target).view).toBe("frozen");

    const later = run(landing.world, index, actions, 1400);
    expect(nodeOf(later.world, T0829.target).view).toBe("frozen");
    expect(cleared(later.events)).toEqual([]);

    const restored = run(later.world, index, [restoreAction(1401, T0829.target)], 1401);
    expect(nodeOf(restored.world, T0829.target).view).toBe("ok");
    expect(cleared(restored.events)).toEqual([
      { k: "effect.cleared", tick: 1401, node: T0829.target, effect: "setView" },
    ]);
  });

  it("a restore for some other node leaves the loss of view alone", () => {
    const result = run(landing.world, index, [restoreAction(401, "dispatch-hmi-2")], 401);
    expect(nodeOf(result.world, T0829.target).view).toBe("frozen");
    expect(cleared(result.events)).toEqual([]);
  });

  it("a restore leaves the intruder's foothold where it was", () => {
    const result = run(landing.world, index, [restoreAction(401, "dispatch-hmi-1")], 401);
    expect(nodeOf(result.world, "dispatch-hmi-1").integrity).toBe(1);
  });

  it("a restore for an unknown node is rejected and changes nothing", () => {
    const result = run(landing.world, index, [restoreAction(401, "no-such-node")], 401);
    expect(result.events).toContainEqual({
      k: "action.rejected",
      tick: 401,
      reason: "unknown-node",
    });
    expect(nodeOf(result.world, T0829.target).view).toBe("frozen");
  });

  it("reaches the same world in one advance and in chunks, restore included", () => {
    const all = [...actions, restoreAction(1401, T0829.target)];
    const start = prepared(T0829, seed);
    const whole = run(start, index, all, 1600);
    let chunked = start;
    for (let from = 0; from < 1600; from += 100) {
      chunked = roundTrip(run(chunked, index, all, from + 100).world);
    }
    expect(nodeOf(whole.world, T0829.target).view).toBe("ok");
    expect(stateHash(chunked)).toBe(stateHash(whole.world));
  });
});

describe("T0836 Modify Parameter caps train speed, and only a restore lifts it", () => {
  const { graph } = index.rail;
  const vmax = graph.vmaxDmPerTick;
  const CLAMP = 250;
  const cap = Math.floor((vmax * CLAMP) / 1000);

  /** The sections the clamped interlocking il-tav serves, read from the rail inputs. */
  const cappedSections = (): Set<string> => {
    const probe = createWorld(network, 0);
    applyEffect(probe, index, "il-tav", { k: "clampParam", param: "speed", permille: CLAMP });
    return new Set(Object.keys(deriveRailInputs(probe, index).paramClamps));
  };
  const capped = cappedSections();

  const sectionAt = (train: TrainState, dm: number): string => {
    const geometry = graph.services.get(train.service);
    if (geometry === undefined) return "";
    for (let i = geometry.blockStartDm.length - 1; i >= 0; i--) {
      if ((geometry.blockStartDm[i] ?? 0) <= dm)
        return graph.sections[geometry.pathSections[i] ?? -1] ?? "";
    }
    return "";
  };
  /** Whole body, front to tail, on sections il-tav caps. */
  const bodyOnCapped = (t: TrainState): boolean =>
    capped.has(sectionAt(t, t.posDm)) && capped.has(sectionAt(t, t.posDm - 1000));

  /** The world at the first tick a train runs at line speed with its body on capped sections. */
  function cruising(): { world: World; train: string } {
    let world = createWorld(network, 0);
    for (let i = 0; i < 4000; i++) {
      world = run(world, index, [], world.tick + 1).world;
      const train = world.trains.find((t) => t.speedDmPerTick === vmax && bodyOnCapped(t));
      if (train !== undefined) return { world, train: train.id };
    }
    throw new Error("no train reached line speed on the sections of il-tav");
  }
  const speedOf = (world: World, id: string): number | undefined =>
    world.trains.find((t) => t.id === id)?.speedDmPerTick;

  it("puts the cap on exactly the sections the clamped interlocking serves, lowest cap winning", () => {
    const world = createWorld(network, 0);
    expect(deriveRailInputs(world, index).paramClamps).toEqual({});

    applyEffect(world, index, "il-tav", { k: "clampParam", param: "speed", permille: CLAMP });
    const clamps = deriveRailInputs(world, index).paramClamps;
    expect(Object.keys(clamps).sort()).toEqual([...capped].sort());
    expect(Object.keys(clamps)).toContain("sec-L1_dn");
    expect(Object.keys(clamps)).not.toContain("sec-L4_dn"); // served by IL-CRE
    for (const value of Object.values(clamps)) expect(value).toBe(CLAMP);

    // A lower cap from an object controller of the same interlocking wins where it reaches.
    applyEffect(world, index, "oc-tav", { k: "clampParam", param: "speed", permille: 100 });
    const both = deriveRailInputs(world, index).paramClamps;
    expect(both["sec-L1_dn"]).toBe(100);
    expect(Math.max(...Object.values(both))).toBe(CLAMP);
  });

  it("a train running at line speed slows to the cap, never speeds up under it, and recovers only after a restore", () => {
    const start = cruising();
    const attacked = roundTrip(start.world);
    applyEffect(attacked, index, "il-tav", { k: "clampParam", param: "speed", permille: CLAMP });

    let world = attacked;
    let previous = vmax;
    let reachedCap = false;
    for (let i = 0; i < 600; i++) {
      world = run(world, index, [], world.tick + 1).world;
      const train = world.trains.find((t) => t.id === start.train);
      if (train === undefined || !bodyOnCapped(train)) break;
      expect(train.speedDmPerTick, `tick ${world.tick}`).toBeLessThanOrEqual(previous);
      previous = train.speedDmPerTick;
      if (previous <= cap) reachedCap = true;
    }
    expect(reachedCap).toBe(true);
    expect(speedOf(world, start.train)).toBeLessThanOrEqual(cap);

    // The same train without the attack would still be running faster than the cap.
    const free = run(start.world, index, [], world.tick);
    expect(speedOf(free.world, start.train) ?? 0).toBeGreaterThan(cap);

    // Restoring lifts the cap; the train speeds up past it again.
    const at = world.tick + 1;
    const restored = run(world, index, [restoreAction(at, "il-tav")], at + 400);
    expect(nodeOf(restored.world, "il-tav").paramClampPermille).toBe(1000);
    expect(cleared(restored.events)).toContainEqual({
      k: "effect.cleared",
      tick: at,
      node: "il-tav",
      effect: "clampParam",
    });
    expect(deriveRailInputs(restored.world, index).paramClamps).toEqual({});
    expect(speedOf(restored.world, start.train) ?? 0).toBeGreaterThan(cap);
  });
});

describe("T0880 Loss of Safety drives the interlocking to its safe state", () => {
  const T0880: Launch = {
    technique: "T0880",
    target: "il-vel",
    foothold: ["ctrl-eng-ws"],
    discovered: ["il-vel"],
  };
  const seed = winningSeed(T0880, "degrade");
  const landing = run(prepared(T0880, seed), index, [launchAction(T0880)], 600);

  it("puts every signal of the interlocking dark and refuses its routes", () => {
    expect(nodeOf(landing.world, "il-vel").availability).toBe("down");
    const aspects = deriveAspects(landing.world, index);
    const signals = index.rail.graph.signals;
    const own = signals.filter((s) => s.interlocking === "IL-VEL");
    expect(own.length).toBeGreaterThan(0);
    signals.forEach((signal, i) => {
      if (signal.interlocking === "IL-VEL") expect(aspects[i], signal.id).toBe("dark");
    });

    const request = run(
      landing.world,
      index,
      [{ t: 601, a: { type: "route.request", route: "R-L2-dn" } }],
      601,
    );
    expect(request.events).toContainEqual(
      expect.objectContaining({
        k: "command.rejected",
        route: "R-L2-dn",
        reason: "interlocking is out of service",
      }),
    );
    expect(request.events.some((e) => e.k === "route.set")).toBe(false);
  });

  it("stays in the safe state with trains running, every tick checked, until it is restored", () => {
    // 3000 more ticks with the invariant asserted each tick; nothing un-darkens the signals.
    const later = run(landing.world, index, [], 3600);
    expect(nodeOf(later.world, "il-vel").availability).toBe("down");
    expect(later.world.interlockings.find((i) => i.id === "IL-VEL")?.health).toBe("down");

    const restored = run(later.world, index, [restoreAction(3601, "il-vel")], 3601);
    expect(nodeOf(restored.world, "il-vel").availability).toBe("ok");
    expect(restored.events).toContainEqual({
      k: "interlocking.health",
      tick: 3601,
      il: "IL-VEL",
      health: "ok",
    });
  });
});

describe("isAction takes an exact shape", () => {
  const valid: Record<string, unknown>[] = [
    { type: "noop" },
    { type: "technique.launch", technique: "T0865", target: "corp-mail" },
    { type: "route.request", route: "R-HAR-dn" },
    { type: "route.cancel", route: "R-HAR-dn" },
    { type: "restore", node: "tms-server" },
  ];

  it("accepts each action as declared and refuses the same action with one key more", () => {
    for (const action of valid) {
      expect(isAction(action), JSON.stringify(action)).toBe(true);
      expect(isAction({ ...action, extra: 1 }), `${JSON.stringify(action)} + extra`).toBe(false);
      expect(isAction({ ...action, node: "x", route: "y" }), "carries foreign keys").toBe(false);
    }
  });

  it("refuses an action that is missing a field or has one of the wrong type", () => {
    expect(isAction({ type: "restore" })).toBe(false);
    expect(isAction({ type: "restore", node: 7 })).toBe(false);
    expect(isAction({ type: "technique.launch", technique: "T0865" })).toBe(false);
    expect(isAction({ type: "route.request", route: null })).toBe(false);
    expect(isAction({ type: "teleport", node: "x" })).toBe(false);
    expect(isAction({ type: "constructor" })).toBe(false);
    expect(isAction(null)).toBe(false);
    expect(isAction("noop")).toBe(false);
    expect(isAction([{ type: "noop" }])).toBe(false);
  });

  it("refuses a parsed action smuggling a prototype key", () => {
    const parsed: unknown = JSON.parse('{"type":"noop","__proto__":{"polluted":true}}');
    expect(isAction(parsed)).toBe(false);
  });

  it("makes assertRecording refuse a recording whose action carries an extra key", () => {
    const fresh = () => JSON.parse(JSON.stringify(recordingJson)) as typeof recordingJson;
    expect(() => assertRecording(fresh())).not.toThrow();

    const tampered = fresh();
    const first = tampered.actions[0];
    if (first === undefined) throw new Error("the committed recording has no actions");
    (first.a as Record<string, unknown>).smuggled = "x";
    expect(() => assertRecording(tampered)).toThrow(/malformed action/);
  });
});
