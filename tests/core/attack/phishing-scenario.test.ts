import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { deriveAspects } from "../../../src/core/rail/interlocking";
import type { SimEvent } from "../../../src/core/sim/events";
import { createWorld } from "../../../src/core/sim/world";
import {
  firstLaunchTick,
  lastLaunchTick,
  networkIndex,
  nodeOf,
  run,
  scenario,
  startWorld,
  warmWorld,
  withoutProtocol,
} from "../../fixtures/attack";

const index = networkIndex();
/** Session time: 10 ticks are one second. */
const T0 = firstLaunchTick;
const SECOND = 10;
const warm = () => warmWorld(index);

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
    const { world, events } = run(warm(), index, scenario.actions, T0 + 56);
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
    const { world } = run(warm(), index, scenario.actions, T0 + 200);
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
    const { world, events } = run(warm(), shut, scenario.actions, T0 + 500);
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
    // T0886 to the relay arrives four ticks after it launches: shut the link after two.
    const relayLaunch = scenario.actions[2]?.t ?? 0;
    const { world, events } = run(
      warm(),
      (tick) => (tick >= relayLaunch + 2 ? shut : index),
      scenario.actions.filter((x) => x.t <= relayLaunch),
      relayLaunch + 200,
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
  const ATTACK_LANDS = 7553; // tick the last technique succeeds, pinned by the recorded seed
  const attacked = run(warm(), index, scenario.actions, scenario.durationTicks);

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

  it("makes the interlockings refuse new routes, so a train halts at a red signal", () => {
    const after = attacked.events.filter((e) => e.tick > ATTACK_LANDS);
    expect(kinds(after, "route.set")).toEqual([]);
    const refusals = kinds(after, "command.rejected");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((r) => r.reason === "command channel is blocked")).toBe(true);
    expect(
      kinds(after, "train.stopped").filter((e) => e.cause === "signal").length,
    ).toBeGreaterThan(0);
  });

  it("leaves every signal at stop and every train standing once the routes already set are used up", () => {
    const settled = run(warm(), index, scenario.actions, ATTACK_LANDS + 2500);
    expect(settled.world.trains.length).toBeGreaterThan(0);
    expect(settled.world.trains.every((t) => t.speedDmPerTick === 0)).toBe(true);
    for (const aspect of deriveAspects(settled.world, index)) {
      expect(["stop", "dark"]).toContain(aspect);
    }
  });

  it("shows the first packet within a second of the start and lands the chain within 20 seconds", () => {
    const packets = kinds(attacked.events, "packet");
    const firstPacket = packets[0]?.tick ?? 0;
    expect(firstPacket - scenario.startTick).toBeLessThanOrEqual(SECOND);
    expect(ATTACK_LANDS - firstPacket).toBeLessThanOrEqual(20 * SECOND);
  });

  it("holds a train that the quiet railway lets through, within 50 seconds of the first packet", () => {
    // Braking is 1 m/s^2, so this is how soon the lost command channel can stop a train at
    // all; the start tick of the scenario is the one where it is soonest. A halt counts only
    // when it is the attack's doing: the train still stands 25 seconds later while on the
    // quiet railway the same train has moved on.
    const firstPacket = kinds(attacked.events, "packet")[0]?.tick ?? 0;
    const halts = kinds(attacked.events, "train.stopped").filter(
      (e) => e.cause === "signal" && e.tick > ATTACK_LANDS,
    );
    const caused = halts.find((e) => {
      const later = e.tick + 250;
      const held = run(warm(), index, scenario.actions, later).world.trains.find(
        (t) => t.id === e.train,
      );
      const free = run(warm(), index, [], later).world.trains.find((t) => t.id === e.train);
      return (
        held !== undefined &&
        held.speedDmPerTick === 0 &&
        (free === undefined || free.posDm > held.posDm + 300)
      );
    });
    if (caused === undefined) throw new Error("the attack held no train");
    expect(caused.tick - firstPacket).toBeLessThanOrEqual(50 * SECOND);
  });

  it("is the attack that stopped them: the same railway keeps running without it", () => {
    const calm = run(warm(), index, [], scenario.durationTicks);
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
    const upTo = T0 + 800;
    const again = run(createWorld(network, scenario.seed), index, scenario.actions, upTo);
    const shorter = run(warm(), index, scenario.actions, upTo);
    expect(again.world).toEqual(shorter.world);
  });
});
