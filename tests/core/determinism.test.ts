import { describe, expect, it } from "vitest";
import { canonicalStringify, fnv1a32, stateHash } from "../../src/core/hash";
import { chance, roll32 } from "../../src/core/rng";
import type { Action } from "../../src/core/sim/actions";
import type { SimEvent } from "../../src/core/sim/events";
import { step } from "../../src/core/sim/step";
import { createWorld, type World } from "../../src/core/sim/world";
import { tinyTopology } from "../fixtures/tiny-topology";

const SEED = 20260930;

/** A busy but fixed action schedule: one launch every 25 ticks, alternating targets. */
function actionsAt(tick: number): Action[] {
  if (tick % 25 !== 0) return [];
  const target = tick % 50 === 0 ? "corp-ws" : "il-1-ctl";
  return [{ type: "technique.launch", technique: "T0865", target }];
}

function run(world: World, from: number, to: number): { world: World; events: SimEvent[] } {
  let current = world;
  const events: SimEvent[] = [];
  for (let tick = from + 1; tick <= to; tick++) {
    const result = step(current, actionsAt(tick));
    current = result.world;
    events.push(...result.events);
  }
  return { world: current, events };
}

const roundTrip = (world: World): World => JSON.parse(JSON.stringify(world)) as World;

function assertOnlyIntegers(value: unknown, path = "world"): void {
  if (typeof value === "number") {
    expect(Number.isInteger(value), `${path} must be an integer`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertOnlyIntegers(item, `${path}[${i}]`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertOnlyIntegers(item, `${path}.${key}`);
  }
}

describe("roll32", () => {
  it("returns the same uint32 for the same keys", () => {
    expect(roll32(SEED, 7, 3, 1)).toBe(roll32(SEED, 7, 3, 1));
    const value = roll32(SEED, 7, 3, 1);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });

  it("differs when any key differs, including a swap of two keys", () => {
    const base = roll32(SEED, 7, 3, 1);
    expect(roll32(SEED + 1, 7, 3, 1)).not.toBe(base);
    expect(roll32(SEED, 8, 3, 1)).not.toBe(base);
    expect(roll32(SEED, 7, 4, 1)).not.toBe(base);
    expect(roll32(SEED, 7, 3, 2)).not.toBe(base);
    expect(roll32(1, 2)).not.toBe(roll32(2, 1));
  });

  it("gives independent substreams per purpose", () => {
    const streamA = Array.from({ length: 64 }, (_, t) => roll32(SEED, t, 5, 100));
    const streamB = Array.from({ length: 64 }, (_, t) => roll32(SEED, t, 5, 101));
    expect(streamA).not.toEqual(streamB);
  });

  it("chance is monotone in permille and honours the extremes", () => {
    for (let t = 0; t < 200; t++) {
      expect(chance(0, SEED, t)).toBe(false);
      expect(chance(1000, SEED, t)).toBe(true);
    }
    let hits = 0;
    for (let t = 0; t < 4000; t++) if (chance(250, SEED, t)) hits++;
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
  });
});

describe("hash", () => {
  it("fnv1a32 matches the published FNV-1a test vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("canonicalStringify sorts keys so insertion order is irrelevant", () => {
    const a = { b: 1, a: { d: [1, 2], c: true } };
    const b = { a: { c: true, d: [1, 2] }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(canonicalStringify(a)).toBe('{"a":{"c":true,"d":[1,2]},"b":1}');
  });

  it("canonicalStringify keeps array order and rejects non-JSON values", () => {
    expect(canonicalStringify([2, 1])).not.toBe(canonicalStringify([1, 2]));
    expect(() => canonicalStringify(new Map())).toThrow();
    expect(() => canonicalStringify({ f: () => 1 })).toThrow();
    expect(() => canonicalStringify({ n: Number.NaN })).toThrow();
  });
});

describe("createWorld and stateHash", () => {
  it("orders entities by id regardless of content insertion order", () => {
    const shuffled = { ...tinyTopology, nodes: [...tinyTopology.nodes].reverse() };
    expect(stateHash(createWorld(shuffled, SEED))).toBe(stateHash(createWorld(tinyTopology, SEED)));
  });

  it("is stable across repeated calls and equal after a JSON round-trip", () => {
    const world = createWorld(tinyTopology, SEED);
    expect(stateHash(world)).toBe(stateHash(world));
    expect(stateHash(roundTrip(world))).toBe(stateHash(world));
    expect(stateHash(createWorld(tinyTopology, SEED))).toBe(stateHash(world));
    expect(stateHash(world)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("holds only integers, so no float ordering can leak into results", () => {
    const { world } = run(createWorld(tinyTopology, SEED), 0, 200);
    assertOnlyIntegers(world);
  });

  it("changes the hash when the seed changes", () => {
    expect(stateHash(createWorld(tinyTopology, SEED))).not.toBe(
      stateHash(createWorld(tinyTopology, SEED + 1)),
    );
  });
});

describe("step", () => {
  it("advances exactly one tick", () => {
    const world = createWorld(tinyTopology, SEED);
    expect(world.tick).toBe(0);
    expect(step(world, []).world.tick).toBe(1);
    expect(step(step(world, []).world, []).world.tick).toBe(2);
  });

  it("is pure: same world and actions give deeply equal results and the input is untouched", () => {
    const world = createWorld(tinyTopology, SEED);
    const before = stateHash(world);
    const actions = actionsAt(50);
    const first = step(world, actions);
    const second = step(world, actions);
    expect(second).toEqual(first);
    expect(canonicalStringify(second.world)).toBe(canonicalStringify(first.world));
    expect(stateHash(world)).toBe(before);
    expect(first.world).not.toBe(world);
  });

  it("advancing 1000 ticks in one loop equals 10 chunks of 100 with a JSON round-trip between", () => {
    const start = createWorld(tinyTopology, SEED);
    const whole = run(start, 0, 1000);

    let chunked = start;
    const chunkedEvents: SimEvent[] = [];
    for (let from = 0; from < 1000; from += 100) {
      const part = run(chunked, from, from + 100);
      chunkedEvents.push(...part.events);
      chunked = roundTrip(part.world);
    }

    expect(stateHash(chunked)).toBe(stateHash(whole.world));
    expect(chunkedEvents).toEqual(whole.events);
    expect(whole.world.tick).toBe(1000);
    expect(stateHash(whole.world)).not.toBe(stateHash(start));
    expect(whole.events.length).toBeGreaterThan(0);
  });

  it("two independent runs of the same seed and actions end on the same hash", () => {
    const a = run(createWorld(tinyTopology, SEED), 0, 500);
    const b = run(createWorld(tinyTopology, SEED), 0, 500);
    expect(stateHash(a.world)).toBe(stateHash(b.world));
    expect(b.events).toEqual(a.events);
  });

  it("a different seed changes the outcome of the dice", () => {
    const a = run(createWorld(tinyTopology, SEED), 0, 2000);
    const b = run(createWorld(tinyTopology, SEED + 1), 0, 2000);
    expect(b.events).not.toEqual(a.events);
  });

  it("rejects an action aimed at an unknown node without changing the world besides the tick", () => {
    const world = createWorld(tinyTopology, SEED);
    const result = step(world, [{ type: "technique.launch", technique: "T0865", target: "nope" }]);
    expect(result.events).toEqual([{ k: "action.rejected", tick: 1, reason: "unknown-node" }]);
    expect(result.world.nodes).toEqual(world.nodes);
  });
});
