import { describe, expect, it } from "vitest";
import { createAttractSession, HOLD_TICKS, LiveQueue, stampAction } from "../../src/app/session";
import { phishingDispatcher } from "../../src/content/scenarios/phishing-dispatcher";
import type { Recording } from "../../src/core/replay/recording";
import type { SimEvent } from "../../src/core/sim/events";
import recordingJson from "../../src/recordings/phishing-dispatcher.json";

const scenario = phishingDispatcher;

describe("attract mode", () => {
  it("boots from the committed recording and plays with no user action", () => {
    const session = createAttractSession();
    expect(session.recording.seed).toBe(recordingJson.seed);
    expect(session.recording.actions).toEqual(recordingJson.actions);
    expect(session.world().tick).toBe(scenario.startTick);
    expect(session.elapsedTicks()).toBe(0);

    session.advance(50);
    expect(session.world().tick).toBe(scenario.startTick + 50);
    expect(session.elapsedTicks()).toBe(50);
    expect(session.status().failure).toBeUndefined();
  });

  it("starts on a busy railway, not an empty one", () => {
    const session = createAttractSession();
    expect(session.world().trains.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the first packet within a second of the start", () => {
    const session = createAttractSession();
    session.advance(10);
    const events = session.drainEvents();
    expect(events.some((e) => e.k === "packet")).toBe(true);
    expect(session.drainEvents()).toEqual([]);
  });

  it("tells the whole story in order and ends with the command channel blocked", () => {
    const session = createAttractSession();
    const seen: SimEvent[] = [];
    while (session.world().tick < scenario.startTick + 300) {
      session.advance(10);
      seen.push(...session.drainEvents());
    }
    const succeeded = seen.filter((e) => e.k === "technique.succeeded").map((e) => e.technique);
    expect(succeeded).toEqual(["T0865", "T0840", "T0886", "T0886", "T0886"]);
    expect(
      seen.some(
        (e) => e.k === "effect.applied" && e.effect === "blockCommands" && e.node === "tms-server",
      ),
    ).toBe(true);
    const tms = session.world().nodes.find((n) => n.id === "tms-server");
    expect(tms?.cmdBlocked).toBe(true);
  });

  it("asserts the safety invariant on every tick, including the quiet stretch before the start", () => {
    const session = createAttractSession();
    expect(session.status().checkedTicks).toBe(scenario.startTick);
    session.advance(100);
    expect(session.status()).toMatchObject({
      held: true,
      violations: [],
      checkedTicks: scenario.startTick + 100,
    });
    expect(session.index.checkInvariants).toBe(true);
  });

  it("plays the whole recording to its hash checkpoints without a mismatch, then starts over", () => {
    const session = createAttractSession();
    const first = session.drainEvents();
    expect(first).toEqual([]);
    const end = scenario.durationTicks + HOLD_TICKS;
    while (session.world().tick < end) {
      session.advance(Math.min(100, end - session.world().tick));
    }
    expect(session.status().failure).toBeUndefined();
    expect(session.status().held).toBe(true);
    expect(session.generation()).toBe(0);

    session.advance(1);
    expect(session.generation()).toBe(1);
    expect(session.world().tick).toBe(scenario.startTick + 1);
    expect(session.previous()?.tick).toBe(scenario.startTick);
    // The second round is the same show: the first packet comes again.
    session.advance(10);
    expect(session.drainEvents().some((e) => e.k === "packet")).toBe(true);
  });

  it("refuses to run a recording that no longer matches the engine, and says so", () => {
    const tampered: Recording = JSON.parse(JSON.stringify(recordingJson));
    const late = tampered.actions[4];
    if (!late) throw new Error("no fifth action");
    tampered.actions[4] = { ...late, t: late.t + 100 };
    const session = createAttractSession({ recording: tampered });
    while (
      session.world().tick < scenario.durationTicks &&
      session.status().failure === undefined
    ) {
      session.advance(100);
    }
    expect(session.status().failure).toMatch(/diverged/);
    const stuck = session.world().tick;
    session.advance(50);
    expect(session.world().tick).toBe(stuck);
  });

  it("rejects a recording that is not a recording", () => {
    expect(() => createAttractSession({ recording: { format: "something else" } })).toThrow();
  });
});

describe("live commands", () => {
  it("are stamped for the next tick and handed to the runner then", () => {
    const session = createAttractSession();
    const action = { type: "route.cancel" as const, route: "R-HAR-dn" };
    const stamped = stampAction(session.world(), action);
    expect(stamped.t).toBe(session.world().tick + 1);

    const queue = new LiveQueue();
    queue.enqueue(stamped);
    expect(queue.due(stamped.t)).toEqual([action]);
    expect(queue.due(stamped.t + 1)).toEqual([]);
  });

  it("are checked like a recorded action: a malformed one is refused with a reason and forks nothing", () => {
    const session = createAttractSession();
    session.advance(5);
    const sneaky = { type: "route.cancel", route: "R-HAR-dn", extra: 1 } as never;
    expect(session.dispatch(sneaky)).toMatch(/not well formed/);
    expect(session.dispatch({ type: "nonsense" } as never)).toMatch(/not well formed/);
    expect(session.live()).toBe(false);
    expect(session.liveActions()).toEqual([]);

    expect(session.dispatch({ type: "route.cancel", route: "R-HAR-dn" })).toBeUndefined();
    expect(session.live()).toBe(true);
    expect(session.liveActions()).toHaveLength(1);
  });
});
