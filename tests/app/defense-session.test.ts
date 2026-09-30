import { describe, expect, it } from "vitest";
import { createAttractSession } from "../../src/app/session";
import { phishingDispatcher } from "../../src/content/scenarios/phishing-dispatcher";
import type { Action } from "../../src/core/sim/actions";
import { DEFENSE_PLACEMENT_LATENCY_TICKS } from "../../src/core/sim/constants";
import type { SimEvent } from "../../src/core/sim/events";

const START = phishingDispatcher.startTick;
const firewall: Action = { type: "defense.place", kind: "firewall", on: { conduit: "c-dmz-ctrl" } };

function play(session: ReturnType<typeof createAttractSession>, untilTick: number): SimEvent[] {
  const seen: SimEvent[] = [];
  while (session.world().tick < untilTick) {
    session.advance(10);
    seen.push(...session.drainEvents());
  }
  return seen;
}

const tms = (session: ReturnType<typeof createAttractSession>) =>
  session.world().nodes.find((n) => n.id === "tms-server");

describe("a defense placed while the recording plays", () => {
  it("branches the run: the rest of the recording plays with the defense in it, and the chain stops", () => {
    const session = createAttractSession();
    expect(session.live()).toBe(false);
    session.advance(5);
    session.dispatch(firewall);
    expect(session.live()).toBe(true);
    const events = play(session, START + 400);

    expect(events.some((e) => e.k === "defense.placed")).toBe(true);
    expect(events.some((e) => e.k === "technique.rejected" || e.k === "op.blocked")).toBe(true);
    expect(tms(session)?.cmdBlocked).toBe(false);
    expect(session.world().defenses.length).toBeGreaterThan(0);
    // Not the recorded run any more, and the session says so instead of failing.
    expect(session.status().failure).toBeUndefined();
    expect(session.status().held).toBe(true);
  });

  it("takes effect only after the placement delay", () => {
    const session = createAttractSession();
    session.dispatch(firewall);
    session.advance(1);
    const placed = session.world().defenses[0];
    expect(placed?.activeFrom).toBe(session.world().tick + DEFENSE_PLACEMENT_LATENCY_TICKS);
  });

  it("without one, the recording still plays to its checkpoints and ends with the channel blocked", () => {
    const session = createAttractSession();
    play(session, START + 400);
    expect(session.live()).toBe(false);
    expect(tms(session)?.cmdBlocked).toBe(true);
    expect(session.status().failure).toBeUndefined();
  });

  it("can be taken away again", () => {
    const session = createAttractSession();
    session.dispatch(firewall);
    play(session, START + 100);
    const id = session.world().defenses[0]?.id;
    expect(id).toBeDefined();
    session.dispatch({ type: "defense.remove", id: id ?? "" });
    play(session, START + 120);
    expect(session.world().defenses).toEqual([]);
  });

  it("starting over drops every live action and is the verified recording again", () => {
    const session = createAttractSession();
    session.dispatch(firewall);
    play(session, START + 100);
    const generation = session.generation();
    session.reset();
    expect(session.live()).toBe(false);
    expect(session.generation()).toBe(generation + 1);
    expect(session.world().tick).toBe(START);
    expect(session.world().defenses).toEqual([]);
    play(session, START + 400);
    expect(tms(session)?.cmdBlocked).toBe(true);
    expect(session.status().failure).toBeUndefined();
  });

  it("a hostile action is refused with an event and the run goes on", () => {
    const session = createAttractSession();
    session.dispatch({ type: "defense.place", kind: "firewall", on: { conduit: "c-nowhere" } });
    const events = play(session, START + 50);
    expect(events.filter((e) => e.k === "action.rejected")).toEqual([
      expect.objectContaining({ reason: "unknown-target" }),
    ]);
    expect(session.status().held).toBe(true);
  });
});
