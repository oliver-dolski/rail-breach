import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { techniques } from "../../../src/content/techniques";
import type { TechniqueDef } from "../../../src/core/attack/types";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import {
  assertInvariants,
  findViolations,
  InvariantViolation,
} from "../../../src/core/rail/invariants";
import { roll32 } from "../../../src/core/rng";
import { type Action, isAction } from "../../../src/core/sim/actions";
import type { SimEvent } from "../../../src/core/sim/events";
import { buildIndex, type Index } from "../../../src/core/sim/model";
import { step } from "../../../src/core/sim/step";
import { createWorld, type World } from "../../../src/core/sim/world";
import { launchAction, prepared, run, winningSeed } from "../../fixtures/attack";
import { miniRail } from "../../fixtures/mini-rail";

const SEEDS = 201; // seeds 0..200
const FUZZ_TICKS = 3000;

const routeIds = network.tracks.routes.map((r) => r.id).sort();
const nodeIds = network.nodes.map((n) => n.id).sort();

/** Dice purposes local to this test; the stateless roll keeps the run reproducible. */
const P_WHEN = 1;
const P_WHAT = 2;
const P_WHICH = 3;
const P_TECHNIQUE = 4;
const P_TARGET = 5;
const P_NODE = 6;
const P_PREPARE = 7;

/** The index the fuzz steps with: the whole catalogue, safety invariant asserted on every tick. */
const catalogueIndex = (): Index => buildIndex(network, { techniques, checkInvariants: true });

/** The nodes a technique may be aimed at, as its own target selector says. */
function validTargets(def: TechniqueDef): string[] {
  const { kinds, roles, tags } = def.targets;
  return network.nodes
    .filter((n) => kinds === undefined || kinds.includes(n.kind))
    .filter((n) => roles === undefined || roles.some((r) => n.roles.includes(r)))
    .filter((n) => tags === undefined || tags.some((t) => n.tags.includes(t)))
    .map((n) => n.id)
    .sort();
}
const targetsOf = new Map(techniques.map((t) => [t.id, validTargets(t)]));

function pick<T>(items: readonly T[], seed: number, tick: number, purpose: number): T {
  const item = items[roll32(seed, tick, purpose) % items.length];
  if (item === undefined) throw new Error("empty pick");
  return item;
}

/**
 * The cyber engine of a later plan sets NodeState fields; here the harness sets
 * them directly. Every value written is a degradation, and every healing write
 * only removes one, so the rail model must hold for every combination.
 */
function disturbNode(world: World, seed: number, tick: number): void {
  const node = world.nodes.find((n) => n.id === pick(nodeIds, seed, tick, P_WHICH));
  if (!node) return;
  switch (roll32(seed, tick, P_WHAT + 10) % 8) {
    case 0:
      node.availability = "down";
      break;
    case 1:
      node.availability = "degraded";
      break;
    case 2:
      node.availability = "ok";
      break;
    case 3:
      node.cmdBlocked = !node.cmdBlocked;
      break;
    case 4:
      node.view = "spoofed";
      break;
    case 5:
      node.view = "ok";
      break;
    case 6:
      node.controlDenied = !node.controlDenied;
      break;
    default:
      node.integrity = 2;
  }
}

interface Tally {
  /** Launches sent against a valid target, and how many of them succeeded, per technique. */
  launched: Record<string, number>;
  succeeded: Record<string, number>;
  /** Effects that ended again, by timing out or by a restore. */
  recoveries: number;
  injected: number;
  rejected: number;
  set: number;
  overruns: number;
  departures: number;
  arrivals: number;
  maxTrains: number;
}

function newTally(): Tally {
  return {
    launched: {},
    succeeded: {},
    recoveries: 0,
    injected: 0,
    rejected: 0,
    set: 0,
    overruns: 0,
    departures: 0,
    arrivals: 0,
    maxTrains: 0,
  };
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * The fail-safe reading of the cyber state, checked on every tick besides the
 * safety invariant: an interlocking that is out of service shows every signal dark,
 * a signal whose lamp controller failed is dark, and a lost command channel takes the
 * proceed away from a route no train has entered. The safety invariant alone would not
 * notice a rule that stopped honouring one of these, because the signal would still be
 * safe to show; the fail-safe behaviour is what makes the attack visible on the track.
 */
function assertFailSafe(world: World, index: Index): void {
  const aspects = deriveAspects(world, index);
  index.rail.graph.signals.forEach((signal, i) => {
    const aspect = aspects[i];
    const il = world.interlockings.find((x) => x.id === signal.interlocking);
    if (il?.health === "down" && aspect !== "dark") {
      throw new Error(`tick ${world.tick}: ${signal.id} shows ${aspect} while ${il.id} is down`);
    }
    if (world.darkSignals.includes(signal.id) && aspect !== "dark") {
      throw new Error(`tick ${world.tick}: ${signal.id} shows ${aspect} with its lamp out`);
    }
    if (il?.cmdBlocked === true && (aspect === "proceed" || aspect === "caution")) {
      const held = il.locks.find(
        (l) => index.rail.routes.byId.get(l.route)?.entry.id === signal.id && !l.used,
      );
      if (held !== undefined) {
        throw new Error(`tick ${world.tick}: ${signal.id} shows ${aspect} with the channel lost`);
      }
    }
  });
}

function fuzzRun(seed: number, index: Index, ticks: number): Tally {
  let world = createWorld(network, seed);
  const tally = newTally();
  for (let i = 0; i < ticks; i++) {
    const tick = world.tick + 1;
    const actions: Action[] = [];
    // about one injection in twenty ticks
    if (roll32(seed, tick, P_WHEN) % 20 === 0) {
      tally.injected += 1;
      switch (roll32(seed, tick, P_WHAT) % 8) {
        case 0:
          actions.push({ type: "route.cancel", route: pick(routeIds, seed, tick, P_WHICH) });
          break;
        case 1:
          actions.push({ type: "route.request", route: pick(routeIds, seed, tick, P_WHICH) });
          break;
        case 2:
          disturbNode(world, seed, tick);
          break;
        case 3:
        case 4:
        case 5: {
          // Any of the 13 techniques against a node it may be aimed at.
          const def = pick(techniques, seed, tick, P_TECHNIQUE);
          const target = pick(targetsOf.get(def.id) ?? [], seed, tick, P_TARGET);
          actions.push({ type: "technique.launch", technique: def.id, target });
          bump(tally.launched, def.id);
          break;
        }
        case 6:
          actions.push({ type: "restore", node: pick(nodeIds, seed, tick, P_NODE) });
          break;
        default: {
          // The attacker gains ground: a foothold or a discovered node, never a loss.
          const node = world.nodes.find((n) => n.id === pick(nodeIds, seed, tick, P_PREPARE));
          if (node === undefined) break;
          if (roll32(seed, tick, P_PREPARE + 10) % 2 === 0) node.integrity = 1;
          else node.discovered = true;
        }
      }
    }
    const result = step(world, actions, index);
    world = result.world;
    assertFailSafe(world, index);
    tally.maxTrains = Math.max(tally.maxTrains, world.trains.length);
    for (const e of result.events) {
      if (e.k === "technique.succeeded") bump(tally.succeeded, e.technique);
      if (e.k === "effect.cleared") tally.recoveries += 1;
      if (e.k === "command.rejected") tally.rejected += 1;
      if (e.k === "route.set") tally.set += 1;
      if (e.k === "train.overran") tally.overruns += 1;
      if (e.k === "train.spawned") tally.departures += 1;
      if (e.k === "train.arrived") tally.arrivals += 1;
    }
  }
  return tally;
}

describe("safety invariant", () => {
  it("holds on the empty network, vacuously", () => {
    const index = buildIndex(network);
    const world = createWorld(network, 0);
    expect(world.trains).toHaveLength(0);
    expect(findViolations(world, index)).toEqual([]);
  });

  it("holds every tick of the un-attacked baseline", () => {
    const index = buildIndex(network, { checkInvariants: true });
    let world = createWorld(network, 0);
    let overruns = 0;
    for (let i = 0; i < 72000; i++) {
      const result = step(world, [], index);
      world = result.world;
      overruns += result.events.filter((e) => e.k === "train.overran").length;
    }
    expect(overruns).toBe(0);
    expect(findViolations(world, index)).toEqual([]);
  });

  it("holds for a single train on the small segment", () => {
    const index = buildIndex(miniRail, { checkInvariants: true });
    let world = createWorld(miniRail, 3);
    for (let i = 0; i < 4000; i++) world = step(world, [], index).world;
    expect(world.tick).toBe(4000);
  });

  it("names each rule it finds broken (planted violations)", () => {
    const index = buildIndex(network);
    const spawn = (id: string, service: string, posDm: number) => ({
      id,
      service,
      posDm,
      speedDmPerTick: 0,
      sig: 0,
      stop: 0,
      dwell: 0,
      overrun: -1,
      lastReq: -100,
    });

    const twoInOne = createWorld(network, 0);
    twoInOne.trains.push(spawn("A#1", "SV-DN", 12000), spawn("B#1", "SV-BR-DN", 12000));
    for (const t of twoInOne.trains) t.sig = 1;
    expect(findViolations(twoInOne, index).join("\n")).toMatch(/holds A#1 and B#1/);

    const pastSignal = createWorld(network, 0);
    pastSignal.trains.push(spawn("A#1", "SV-DN", 6000));
    expect(findViolations(pastSignal, index).join("\n")).toMatch(
      /past S-HAR-dn without having been let through/,
    );

    const tooFast = createWorld(network, 0);
    const runaway = spawn("A#1", "SV-DN", 8400);
    runaway.sig = 1;
    runaway.speedDmPerTick = 33;
    runaway.overrun = 0;
    tooFast.trains.push(runaway);
    expect(findViolations(tooFast, index).join("\n")).toMatch(
      /cannot stop short of the overlap of S-HAR-dn/,
    );

    const conflicting = createWorld(network, 0);
    const il = conflicting.interlockings.find((i) => i.id === "IL-VEL");
    il?.locks.push({ route: "R-VEL-dn-br", used: false }, { route: "R-VEL-dn-main", used: false });
    expect(findViolations(conflicting, index).join("\n")).toMatch(
      /R-VEL-dn-br and R-VEL-dn-main conflict/,
    );

    const underTrain = createWorld(network, 0);
    const point = underTrain.points.find((p) => p.id === "J1");
    if (point) {
      point.target = "reverse";
      point.moving = 30;
    }
    const sitting = spawn("A#1", "SV-DN", 65000);
    sitting.sig = 5;
    underTrain.trains.push(sitting);
    expect(findViolations(underTrain, index).join("\n")).toMatch(
      /point J1 is moving while section/,
    );

    expect(() => assertInvariants(twoInOne, index)).toThrow(InvariantViolation);
  });

  it("has no action that could set a permissive state", () => {
    expect(isAction({ type: "signal.set", signal: "S-HAR-dn", aspect: "proceed" })).toBe(false);
    expect(isAction({ type: "route.force", route: "R-HAR-dn" })).toBe(false);
    expect(isAction({ type: "point.move", point: "J1" })).toBe(false);
    expect(isAction({ type: "train.move", train: "SV-DN#1" })).toBe(false);
    expect(isAction({ type: "route.cancel", route: "R-HAR-dn" })).toBe(true);
  });

  it(`holds under random commands, all 13 techniques and restores over seeds 0..${SEEDS - 1}`, () => {
    const index = catalogueIndex();
    const total = newTally();
    for (let seed = 0; seed < SEEDS; seed++) {
      // step() throws InvariantViolation on the first broken rule
      const tally = fuzzRun(seed, index, FUZZ_TICKS);
      for (const [id, n] of Object.entries(tally.launched))
        total.launched[id] = (total.launched[id] ?? 0) + n;
      for (const [id, n] of Object.entries(tally.succeeded))
        total.succeeded[id] = (total.succeeded[id] ?? 0) + n;
      total.recoveries += tally.recoveries;
      total.injected += tally.injected;
      total.rejected += tally.rejected;
      total.set += tally.set;
      total.overruns += tally.overruns;
      total.departures += tally.departures;
      total.arrivals += tally.arrivals;
      total.maxTrains = Math.max(total.maxTrains, tally.maxTrains);
    }
    // the fuzz really exercised the model: commands went in, some were refused, trains ran
    expect(total.injected).toBeGreaterThan(SEEDS * 100);
    expect(total.rejected).toBeGreaterThan(SEEDS * 10);
    expect(total.set).toBeGreaterThan(SEEDS * 5);
    expect(total.departures).toBeGreaterThan(SEEDS);
    expect(total.maxTrains).toBeGreaterThanOrEqual(3);
    // ... and it drew on the whole catalogue: every technique was launched and every one landed
    // at least once, and effects were lifted again (by restore or by timing out).
    for (const def of techniques) {
      expect(total.launched[def.id] ?? 0, `${def.id} launched`).toBeGreaterThan(0);
      expect(total.succeeded[def.id] ?? 0, `${def.id} succeeded`).toBeGreaterThan(0);
    }
    expect(total.recoveries).toBeGreaterThan(SEEDS);
  }, 300_000);

  it("gives the same result for the same seed", () => {
    const index = catalogueIndex();
    expect(fuzzRun(17, index, 1500)).toEqual(fuzzRun(17, index, 1500));
  });
});

describe("unsafe commands are refused with a reason", () => {
  function refusals(events: SimEvent[]): Extract<SimEvent, { k: "command.rejected" }>[] {
    return events.filter(
      (e): e is Extract<SimEvent, { k: "command.rejected" }> => e.k === "command.rejected",
    );
  }

  it("rejects a route that conflicts with a locked route and says which", () => {
    const index = buildIndex(network, { checkInvariants: true });
    const first = step(
      createWorld(network, 0),
      [{ type: "route.request", route: "R-VEL-dn-main" }],
      index,
    );
    expect(first.events.some((e) => e.k === "route.set" && e.route === "R-VEL-dn-main")).toBe(true);
    const second = step(first.world, [{ type: "route.request", route: "R-VEL-dn-br" }], index);
    const [refusal, ...rest] = refusals(second.events);
    expect(rest).toEqual([]);
    expect(refusal?.route).toBe("R-VEL-dn-br");
    expect(refusal?.il).toBe("IL-VEL");
    expect(refusal?.reason).toBe("conflicts with locked route R-VEL-dn-main");
    expect(
      second.world.interlockings.find((i) => i.id === "IL-VEL")?.locks.map((l) => l.route),
    ).toEqual(["R-VEL-dn-main"]);
  });

  it("rejects a route over an occupied section and does not lock it", () => {
    const index = buildIndex(network);
    const world = createWorld(network, 0);
    world.trains.push({
      id: "X#1",
      service: "SV-DN",
      posDm: 20000,
      speedDmPerTick: 0,
      sig: 1,
      stop: 0,
      dwell: 0,
      overrun: -1,
      lastReq: -100,
    });
    const result = step(world, [{ type: "route.request", route: "R-HAR-dn" }], index);
    expect(refusals(result.events).map((e) => e.reason)).toEqual(["section sec-L1_dn is occupied"]);
    expect(result.world.interlockings.every((i) => i.locks.length === 0)).toBe(true);
  });

  it("rejects a route over a section reported disturbed", () => {
    const index = buildIndex(network);
    const world = createWorld(network, 0);
    const oc = world.nodes.find((n) => n.id === "oc-tav");
    if (oc) oc.availability = "degraded";
    const result = step(world, [{ type: "route.request", route: "R-HAR-dn" }], index);
    expect(refusals(result.events).map((e) => e.reason)).toEqual([
      "section sec-L1_dn is disturbed",
    ]);
  });

  it("rejects everything while the command channel is blocked or the interlocking is down", () => {
    const index = buildIndex(network);
    const blocked = createWorld(network, 0);
    const fep = blocked.nodes.find((n) => n.id === "fep");
    if (fep) fep.cmdBlocked = true;
    const a = step(blocked, [{ type: "route.request", route: "R-L2-dn" }], index);
    expect(refusals(a.events).map((e) => e.reason)).toEqual(["command channel is blocked"]);

    const down = createWorld(network, 0);
    const il = down.nodes.find((n) => n.id === "il-vel");
    if (il) il.availability = "down";
    const b = step(down, [{ type: "route.request", route: "R-L2-dn" }], index);
    expect(refusals(b.events).map((e) => e.reason)).toEqual(["interlocking is out of service"]);
    expect(b.events.some((e) => e.k === "interlocking.health" && e.health === "down")).toBe(true);
  });

  it("rejects an unknown route", () => {
    const index = buildIndex(network);
    const result = step(
      createWorld(network, 0),
      [{ type: "route.request", route: "R-NOPE" }],
      index,
    );
    expect(refusals(result.events).map((e) => e.reason)).toEqual(["unknown route"]);
  });

  it("accepts a restrictive request: cancelling a held route that no train is near", () => {
    const index = buildIndex(network, { checkInvariants: true });
    const set = step(
      createWorld(network, 0),
      [{ type: "route.request", route: "R-VEL-dn-main" }],
      index,
    );
    const cancelled = step(set.world, [{ type: "route.cancel", route: "R-VEL-dn-main" }], index);
    expect(refusals(cancelled.events)).toEqual([]);
    expect(cancelled.events.some((e) => e.k === "route.released" && e.cause === "cancelled")).toBe(
      true,
    );
    expect(cancelled.world.interlockings.every((i) => i.locks.length === 0)).toBe(true);
  });

  it("refuses to cancel a route once a train is within braking distance of its signal", () => {
    const index = buildIndex(network, { checkInvariants: true });
    let world = createWorld(network, 0);
    // R-HAR-dn is set by the dispatch layer as soon as SV-DN#1 appears
    for (let i = 0; i < 110; i++) world = step(world, [], index).world;
    const held = world.interlockings.flatMap((il) => il.locks).map((l) => l.route);
    expect(held).toContain("R-HAR-dn");
    const result = step(world, [{ type: "route.cancel", route: "R-HAR-dn" }], index);
    expect(refusals(result.events).map((e) => e.reason)).toEqual([
      "approach locked: a train is within braking distance of the signal",
    ]);
  });
});

describe("liveness after a restoration", () => {
  const index = catalogueIndex();
  const routeSets = (events: SimEvent[], il?: string) =>
    events.filter((e) => e.k === "route.set" && (il === undefined || e.il === il)).length;
  const arrivals = (events: SimEvent[]) => events.filter((e) => e.k === "train.arrived").length;

  it("Loss of Safety holds the interlocking out, and a restore lets it take routes and pass trains again", () => {
    const launch = {
      technique: "T0880",
      target: "il-vel",
      foothold: ["ctrl-eng-ws"],
      discovered: ["il-vel"],
    };
    const seed = winningSeed(launch, "degrade", index);
    const landed = run(prepared(launch, seed), index, [launchAction(launch)], 600);
    expect(landed.world.nodes.find((n) => n.id === "il-vel")?.availability).toBe("down");

    const held = run(landed.world, index, [], 3000);
    expect(routeSets(held.events, "IL-VEL")).toBe(0);

    const restore = { t: 3001, a: { type: "restore" as const, node: "il-vel" } };
    const after = run(held.world, index, [restore], 12000);
    expect(after.world.nodes.find((n) => n.id === "il-vel")?.availability).toBe("ok");
    expect(routeSets(after.events, "IL-VEL")).toBeGreaterThan(0);
    expect(arrivals(after.events)).toBeGreaterThan(arrivals(held.events));
  });

  it("a blocked command channel refuses every route, and a restore brings the dispatcher back", () => {
    const launch = {
      technique: "T1691.001",
      target: "tms-server",
      foothold: ["dispatch-hmi-1"],
      discovered: ["tms-server"],
    };
    const seed = winningSeed(launch, "blockCommands", index);
    const landed = run(prepared(launch, seed), index, [launchAction(launch)], 600);
    expect(landed.world.nodes.find((n) => n.id === "tms-server")?.cmdBlocked).toBe(true);

    const held = run(landed.world, index, [], 3000);
    expect(routeSets(held.events)).toBe(0);

    const restore = { t: 3001, a: { type: "restore" as const, node: "tms-server" } };
    const after = run(held.world, index, [restore], 12000);
    expect(after.world.nodes.find((n) => n.id === "tms-server")?.cmdBlocked).toBe(false);
    expect(routeSets(after.events)).toBeGreaterThan(0);
    expect(arrivals(after.events)).toBeGreaterThan(arrivals(held.events));
  });
});
