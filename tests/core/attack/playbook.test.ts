import { describe, expect, it } from "vitest";
import { type Action, isAction } from "../../../src/core/sim/actions";
import {
  MAX_PLAYBOOK_STEPS,
  MAX_PLAYBOOKS,
  PLAYBOOK_GAP_TICKS,
} from "../../../src/core/sim/constants";
import type { SimEvent } from "../../../src/core/sim/events";
import { networkIndex, nodeOf, run, startWorld } from "../../fixtures/attack";

const index = networkIndex();

const chain: Action = {
  type: "playbook.start",
  steps: [
    { technique: "T0865", target: { role: "dispatcher-ws" } },
    { technique: "T0840", target: { node: "corp-ws-dispatch" } },
    { technique: "T0886", target: { node: "dmz-relay" } },
  ],
};

const started = (events: readonly SimEvent[]) =>
  events.filter((e): e is Extract<SimEvent, { k: "op.started" }> => e.k === "op.started");

/** Finds a seed in which every step of the chain finds what it needs, so all three start. */
function winningSeed(): number {
  for (let seed = 0; seed < 40; seed++) {
    const { events } = run({ ...startWorld(), seed }, index, [{ t: 5, a: chain }], 600);
    if (started(events).length === 3) return seed;
  }
  throw new Error("no seed runs the whole chain");
}

describe("playbook.start", () => {
  it("launches its steps in order, each after the operation before it has ended", () => {
    const seed = winningSeed();
    const { events } = run({ ...startWorld(), seed }, index, [{ t: 5, a: chain }], 600);
    const ops = started(events);
    expect(ops.map((o) => [o.technique, o.target])).toEqual([
      ["T0865", "corp-ws-dispatch"],
      ["T0840", "corp-ws-dispatch"],
      ["T0886", "dmz-relay"],
    ]);
    const ended = (op: number): number => {
      const e = events.find(
        (x) =>
          (x.k === "technique.succeeded" || x.k === "technique.failed" || x.k === "op.blocked") &&
          x.op === op,
      );
      if (e === undefined) throw new Error(`op ${op} never ended`);
      return e.tick;
    };
    expect(ops[0]?.tick).toBe(5);
    for (let i = 1; i < ops.length; i++) {
      const previous = ops[i - 1];
      expect(ops[i]?.tick).toBe(ended(previous?.op ?? -1) + PLAYBOOK_GAP_TICKS);
    }
  });

  it("aims a role at the first node of that role the technique admits", () => {
    const only: Action = {
      type: "playbook.start",
      steps: [{ technique: "T0865", target: { role: "office-ws" } }],
    };
    const { events } = run(startWorld(), index, [{ t: 5, a: only }], 10);
    expect(started(events).map((o) => o.target)).toEqual(["corp-ws-office"]);
  });

  it("aims a step with no target at a node the technique can be launched at", () => {
    const only: Action = { type: "playbook.start", steps: [{ technique: "T0865" }] };
    const { events } = run(startWorld(), index, [{ t: 5, a: only }], 10);
    expect(started(events)).toHaveLength(1);
  });

  it("refuses a step that needs what no earlier step won, with the reasons, and goes on", () => {
    const refused: Action = {
      type: "playbook.start",
      steps: [
        { technique: "T0886", target: { node: "tms-server" } },
        { technique: "T0865", target: { role: "dispatcher-ws" } },
      ],
    };
    const { events } = run(startWorld(), index, [{ t: 5, a: refused }], 40);
    const rejected = events.find((e) => e.k === "technique.rejected");
    expect(rejected).toMatchObject({ technique: "T0886", target: "tms-server" });
    expect(started(events).map((o) => o.technique)).toEqual(["T0865"]);
  });

  it("refuses an unknown technique and a role nothing carries without crashing", () => {
    const bad: Action = {
      type: "playbook.start",
      steps: [{ technique: "T9999" }, { technique: "T0865", target: { role: "no-such-role" } }],
    };
    const { events } = run(startWorld(), index, [{ t: 5, a: bad }], 40);
    const reasons = events.flatMap((e) => (e.k === "technique.rejected" ? e.reasons : []));
    expect(reasons).toEqual(["unknown technique", "no node fits the target"]);
  });

  it("drops a finished playbook from the world", () => {
    const { world } = run(startWorld(), index, [{ t: 5, a: chain }], 600);
    expect(world.playbooks).toEqual([]);
  });

  it("takes on only MAX_PLAYBOOKS at once", () => {
    const one: Action = {
      type: "playbook.start",
      steps: [{ technique: "T0865" }, { technique: "T0840" }],
    };
    const actions = Array.from({ length: MAX_PLAYBOOKS + 2 }, () => ({ t: 5, a: one }));
    const { events } = run(startWorld(), index, actions, 5);
    const refused = events.filter(
      (e) => e.k === "action.rejected" && e.reason === "playbook-limit",
    );
    expect(refused).toHaveLength(2);
  });

  it("runs the same way twice and leaves the input world alone", () => {
    const before = JSON.stringify(startWorld());
    const a = run(startWorld(), index, [{ t: 5, a: chain }], 300);
    const b = run(startWorld(), index, [{ t: 5, a: chain }], 300);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
    expect(JSON.stringify(startWorld())).toBe(before);
    expect(nodeOf(a.world, "corp-ws-dispatch")).toBeDefined();
  });
});

describe("isAction for playbook.start", () => {
  const step = { technique: "T0865", target: { role: "dispatcher-ws" } };

  it("accepts the three target forms and no target", () => {
    for (const target of [{ role: "r" }, { node: "n" }, { zone: "z" }, undefined]) {
      const s = target === undefined ? { technique: "T0865" } : { technique: "T0865", target };
      expect(isAction({ type: "playbook.start", steps: [s] })).toBe(true);
    }
  });

  it("rejects a step that carries an extra key, and a target that carries two", () => {
    const two = { technique: "T0865", target: { role: "a", node: "b" } };
    expect(isAction({ type: "playbook.start", steps: [{ ...step, extra: 1 }] })).toBe(false);
    expect(isAction({ type: "playbook.start", steps: [two] })).toBe(false);
    expect(isAction({ type: "playbook.start", steps: [{ technique: "T0865", target: {} }] })).toBe(
      false,
    );
    expect(
      isAction({ type: "playbook.start", steps: [{ technique: "T0865", target: { role: 1 } }] }),
    ).toBe(false);
    expect(isAction({ type: "playbook.start", steps: [step], extra: 1 })).toBe(false);
  });

  it("rejects no steps, too many, a non-array and a non-string technique", () => {
    expect(isAction({ type: "playbook.start", steps: [] })).toBe(false);
    expect(
      isAction({ type: "playbook.start", steps: Array(MAX_PLAYBOOK_STEPS + 1).fill(step) }),
    ).toBe(false);
    expect(isAction({ type: "playbook.start", steps: Array(MAX_PLAYBOOK_STEPS).fill(step) })).toBe(
      true,
    );
    expect(isAction({ type: "playbook.start", steps: "T0865" })).toBe(false);
    expect(isAction({ type: "playbook.start", steps: [{ technique: 7 }] })).toBe(false);
    expect(isAction({ type: "playbook.start", steps: [null] })).toBe(false);
  });
});
