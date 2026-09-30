import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { canonicalStringify, stateHash } from "../../../src/core/hash";
import {
  RECORDING_FORMAT,
  RECORDING_SCHEMA,
  type Recording,
} from "../../../src/core/replay/recording";
import { createRunner } from "../../../src/core/replay/runner";
import { RecordedSource } from "../../../src/core/replay/source";
import type { Action } from "../../../src/core/sim/actions";
import { buildIndex } from "../../../src/core/sim/model";
import { step } from "../../../src/core/sim/step";
import { createWorld, type World } from "../../../src/core/sim/world";

const index = buildIndex(network, { checkInvariants: true });

const recording: Recording = {
  format: RECORDING_FORMAT,
  schema: RECORDING_SCHEMA,
  seed: 11,
  tickMs: 100,
  durationTicks: 6000,
  actions: [
    { t: 400, a: { type: "route.cancel", route: "R-L1-dn" } },
    { t: 900, a: { type: "route.request", route: "R-TAV-dn" } },
    { t: 900, a: { type: "route.request", route: "R-L2-dn" } },
    { t: 2500, a: { type: "route.cancel", route: "R-VEL-dn-main" } },
  ],
  checkpoints: [],
};

function replay(chunks: number[]): { hash: string; checkpoints: string } {
  const runner = createRunner(
    createWorld(network, recording.seed),
    new RecordedSource(recording),
    index,
  );
  for (const n of chunks) runner.advance(n);
  return {
    hash: stateHash(runner.view()),
    checkpoints: runner
      .checkpoints()
      .map((c) => `${c.t}:${c.h}`)
      .join(","),
  };
}

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

describe("the rail step is deterministic", () => {
  it("gives identical checkpoints whatever the run chunking", () => {
    const whole = replay([6000]);
    expect(replay([1, 99, 900, 1, 2999, 2000]).checkpoints).toBe(whole.checkpoints);
    expect(replay(Array(60).fill(100)).checkpoints).toBe(whole.checkpoints);
    expect(replay(Array(6000).fill(1)).hash).toBe(whole.hash);
  });

  it("continues identically after the world is serialised and restored mid-run", () => {
    const actions = (tick: number): Action[] =>
      tick === 700 ? [{ type: "route.cancel", route: "R-L1-dn" }] : [];
    let straight = createWorld(network, 5);
    let restored = createWorld(network, 5);
    for (let tick = 1; tick <= 3000; tick++) {
      straight = step(straight, actions(tick), index).world;
      restored = step(restored, actions(tick), index).world;
      if (tick === 1500) restored = JSON.parse(JSON.stringify(restored)) as World;
    }
    expect(canonicalStringify(restored)).toBe(canonicalStringify(straight));
  });

  it("never mutates the world it is given", () => {
    let world = createWorld(network, 3);
    for (let i = 0; i < 1500; i++) world = step(world, [], index).world;
    const before = canonicalStringify(world);
    step(world, [{ type: "route.request", route: "R-L2-dn" }], index);
    expect(canonicalStringify(world)).toBe(before);
  });

  it("keeps the world plain integer JSON", () => {
    let world = createWorld(network, 3);
    for (let i = 0; i < 5000; i++) world = step(world, [], index).world;
    assertOnlyIntegers(world);
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  it("orders simultaneous requests by route id, not by the order they arrived in", () => {
    const a: Action = { type: "route.request", route: "R-TAV-dn" };
    const b: Action = { type: "route.request", route: "R-HAR-dn" };
    const first = step(createWorld(network, 0), [a, b], index);
    const second = step(createWorld(network, 0), [b, a], index);
    expect(canonicalStringify(first.world)).toBe(canonicalStringify(second.world));
    expect(first.events).toEqual(second.events);
  });

  it("does not depend on the order content lists its items in", () => {
    const shuffled = {
      ...network,
      tracks: {
        ...network.tracks,
        blocks: [...network.tracks.blocks].reverse(),
        signals: [...network.tracks.signals].reverse(),
        routes: [...network.tracks.routes].reverse(),
        services: [...network.tracks.services].reverse(),
        points: [...network.tracks.points].reverse(),
      },
      nodes: [...network.nodes].reverse(),
    };
    const other = buildIndex(shuffled, { checkInvariants: true });
    let a = createWorld(network, 9);
    let b = createWorld(shuffled, 9);
    for (let i = 0; i < 4000; i++) {
      a = step(a, [], index).world;
      b = step(b, [], other).world;
    }
    expect(stateHash(b)).toBe(stateHash(a));
  });
});
