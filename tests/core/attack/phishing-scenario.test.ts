import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import type { SimEvent } from "../../../src/core/sim/events";
import { createWorld } from "../../../src/core/sim/world";
import {
  lastLaunchTick,
  networkIndex,
  nodeOf,
  run,
  scenario,
  startWorld,
  withoutProtocol,
} from "../../fixtures/attack";

const index = networkIndex();

const CHAIN = new Set(["T0865", "T0840", "T0886"]);
const ATTACK_EVENTS = new Set([
  "op.started",
  "packet",
  "op.blocked",
  "technique.succeeded",
  "technique.failed",
  "technique.rejected",
  "effect.applied",
]);

const launch = (t: number, technique: string, target: string) => ({
  t,
  a: { type: "technique.launch" as const, technique, target },
});

function kinds<K extends SimEvent["k"]>(events: SimEvent[], k: K): Extract<SimEvent, { k: K }>[] {
  return events.filter((e): e is Extract<SimEvent, { k: K }> => e.k === k);
}

describe("T0865 Spearphishing Attachment", () => {
  it("travels from the outside through the mail gateway and lands a user foothold", () => {
    const { world, events } = run(startWorld(), index, scenario.actions, 300);
    expect(kinds(events, "op.started")[0]).toMatchObject({
      technique: "T0865",
      target: "corp-ws-dispatch",
      from: "internet",
    });
    const hops = kinds(events, "packet").filter((p) => p.technique === "T0865");
    expect(hops.map((p) => [p.from, p.to])).toEqual([
      ["internet", "corp-mail"],
      ["corp-mail", "corp-ws-dispatch"],
    ]);
    expect(kinds(events, "technique.succeeded").map((e) => e.technique)).toEqual(["T0865"]);
    expect(nodeOf(world, "corp-ws-dispatch").integrity).toBe(1);
    expect(nodeOf(world, "corp-mail").integrity).toBe(0);
  });

  it("is refused against a node that is not a workstation", () => {
    const { events } = run(startWorld(), index, [launch(5, "T0865", "tms-server")], 6);
    expect(kinds(events, "technique.rejected")).toEqual([
      expect.objectContaining({ technique: "T0865", target: "tms-server" }),
    ]);
  });
});

describe("T0840 Network Connection Enumeration", () => {
  it("needs a foothold on the node it runs on", () => {
    const { events } = run(startWorld(), index, [launch(5, "T0840", "corp-ws-dispatch")], 6);
    expect(kinds(events, "technique.rejected")[0]?.reasons).toContain(
      "no foothold on corp-ws-dispatch",
    );
  });

  it("marks what is within three links and nothing beyond", () => {
    const { world } = run(startWorld(), index, scenario.actions, 400);
    for (const near of ["corp-mail", "dmz-relay", "dispatch-hmi-1", "tms-server"]) {
      expect(nodeOf(world, near).discovered, near).toBe(true);
    }
    // vendor-jump is five links from the dispatcher workstation.
    expect(nodeOf(world, "vendor-jump").discovered).toBe(false);
    expect(nodeOf(world, "il-vel").discovered).toBe(false);
  });
});

describe("T0886 Remote Services", () => {
  it("is refused without a foothold to start from and without discovery", () => {
    const { events } = run(startWorld(), index, [launch(5, "T0886", "tms-server")], 6);
    const reasons = kinds(events, "technique.rejected")[0]?.reasons ?? [];
    expect(reasons).toContain(
      "no permitted remote-services path from a compromised node to tms-server",
    );
    expect(reasons).toContain("tms-server has not been discovered");
  });

  it("moves only over conduits that permit remote-services", () => {
    // The corporate-to-DMZ link stops carrying remote sessions.
    const shut = networkIndex(withoutProtocol("l-dispatch-dmz", "remote-services"));
    const { world, events } = run(startWorld(), shut, scenario.actions, 700);
    expect(nodeOf(world, "corp-ws-dispatch").integrity).toBe(1);
    expect(nodeOf(world, "dmz-relay").integrity).toBe(0);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
    const refused = kinds(events, "technique.rejected").filter((e) => e.technique === "T0886");
    expect(refused).toHaveLength(3);
    expect(refused[0]?.reasons).toContain(
      "no permitted remote-services path from a compromised node to dmz-relay",
    );
  });

  it("ends a payload that finds its link shut while it is in flight, and says so", () => {
    const shut = networkIndex(withoutProtocol("l-dispatch-dmz", "remote-services"));
    // T0886 to the relay launches at 400 and would arrive at 404: shut the link at 402.
    const { world, events } = run(
      startWorld(),
      (tick) => (tick >= 402 ? shut : index),
      scenario.actions.filter((x) => x.t <= 400),
      600,
    );
    expect(kinds(events, "op.blocked")).toEqual([
      expect.objectContaining({
        technique: "T0886",
        link: "l-dispatch-dmz",
        at: "corp-ws-dispatch",
      }),
    ]);
    expect(nodeOf(world, "dmz-relay").integrity).toBe(0);
    expect(world.ops).toEqual([]);
  });
});

describe("the phishing chain end to end", () => {
  const ATTACK_LANDS = 649; // tick the last technique succeeds, pinned by the recorded seed
  const attacked = run(startWorld(), index, scenario.actions, scenario.durationTicks);

  it("succeeds at every step with the recorded seed, in order", () => {
    const done = kinds(attacked.events, "technique.succeeded");
    expect(done.map((e) => [e.technique, e.node])).toEqual([
      ["T0865", "corp-ws-dispatch"],
      ["T0840", "corp-ws-dispatch"],
      ["T0886", "dmz-relay"],
      ["T0886", "dispatch-hmi-1"],
      ["T0886", "tms-server"],
    ]);
    expect(done.at(-1)?.tick).toBe(ATTACK_LANDS);
    expect(kinds(attacked.events, "technique.failed")).toEqual([]);
    expect(kinds(attacked.events, "technique.rejected")).toEqual([]);
  });

  it("carries the technique ID on every step and only uses techniques of the chain", () => {
    const steps = attacked.events.filter((e) => ATTACK_EVENTS.has(e.k));
    expect(steps.length).toBeGreaterThan(10);
    for (const event of steps) {
      expect(event, JSON.stringify(event)).toHaveProperty("technique");
      const technique = (event as { technique: string }).technique;
      expect(CHAIN.has(technique), technique).toBe(true);
    }
    // One hop at a time: a packet never skips a node.
    for (const p of kinds(attacked.events, "packet")) {
      expect(p.arriveTick).toBeGreaterThan(p.tick);
    }
  });

  it("ends in a restrictive supervisory effect on the traffic management server", () => {
    const tms = nodeOf(attacked.world, "tms-server");
    expect(tms.integrity).toBe(1);
    expect(tms.cmdBlocked).toBe(true);
    expect(tms.controlDenied).toBe(true);
    const effects = kinds(attacked.events, "effect.applied").filter((e) => e.node === "tms-server");
    expect(effects.map((e) => e.effect)).toEqual(["foothold", "blockCommands", "denyControl"]);
  });

  it("makes the interlockings refuse new routes, so the signals fall to stop and a train halts", () => {
    const after = attacked.events.filter((e) => e.tick > ATTACK_LANDS);
    expect(kinds(after, "route.set")).toEqual([]);
    const refusals = kinds(after, "command.rejected");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((r) => r.reason === "command channel is blocked")).toBe(true);

    const halted = kinds(after, "train.stopped").filter((e) => e.cause === "signal");
    expect(halted.length).toBeGreaterThan(0);
    expect(attacked.world.trains.length).toBeGreaterThan(0);
    expect(attacked.world.trains.every((t) => t.speedDmPerTick === 0)).toBe(true);
    for (const aspect of deriveAspects(attacked.world, index)) {
      expect(["stop", "dark"]).toContain(aspect);
    }
  });

  it("is the attack that stopped them: the same railway keeps running without it", () => {
    const calm = run(startWorld(), index, [], scenario.durationTicks);
    const setAfter = kinds(calm.events, "route.set").filter((e) => e.tick > ATTACK_LANDS);
    expect(setAfter.length).toBeGreaterThan(0);
    expect(calm.world.trains.some((t) => t.speedDmPerTick > 0)).toBe(true);
  });

  it("never lets the safety invariant break (asserted on every tick of the run)", () => {
    // The index was built with checkInvariants, so a violation would have thrown above.
    expect(index.checkInvariants).toBe(true);
    expect(attacked.world.tick).toBe(scenario.durationTicks);
    expect(lastLaunchTick).toBeLessThan(ATTACK_LANDS);
  });

  it("does not depend on which world instance runs it", () => {
    const again = run(createWorld(network, scenario.seed), index, scenario.actions, 800);
    const shorter = run(startWorld(), index, scenario.actions, 800);
    expect(again.world).toEqual(shorter.world);
  });
});
