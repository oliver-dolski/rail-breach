import { describe, expect, it } from "vitest";
import { catalog } from "../../src/app/catalog";
import { createAttractSession } from "../../src/app/session";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import type { SimEvent } from "../../src/core/sim/events";
import { ALERT_COLORS } from "../../src/render/palette";
import { MIN_TRAVEL_SECONDS } from "../../src/render/particleRing";
import {
  AttackTrail,
  TRAIL_AFTERGLOW,
  TRAIL_COOL_SECONDS,
  TRAIL_HEAD,
  TRAIL_MAX_HOPS,
  TRAIL_RELIGHT_MIN_TICKS,
} from "../../src/render/trail";
import { buildView, createViewContext } from "../../src/render/view";
import { networkIndex, warmWorld } from "../fixtures/attack";

type Packet = Extract<SimEvent, { k: "packet" }>;

const packet = (tick: number, from: string, to: string, arriveTick = tick + 4): Packet => ({
  k: "packet",
  tick,
  op: 1,
  technique: "T0865",
  link: "l-test",
  from,
  to,
  arriveTick,
});

const A = "internet";
const B = "corp-mail";
const at = (id: string): { x: number; y: number } => {
  const p = layout.nodes[id];
  if (!p) throw new Error(`no node ${id}`);
  return p;
};

describe("the attack trail, one hop", () => {
  const trail = () => {
    const t = new AttackTrail(layout);
    t.ingest([packet(100, A, B)]);
    return t;
  };

  it("lights nothing before the packet starts", () => {
    expect(trail().lines(9.99, false)).toEqual([]);
    expect(new AttackTrail(layout).lines(50, false)).toEqual([]);
  });

  it("draws a bright head that grows with the packet while it is in flight", () => {
    const [head, ...rest] = trail().lines(10 + MIN_TRAVEL_SECONDS / 2, false);
    expect(rest).toEqual([]);
    const a = at(A);
    const b = at(B);
    expect(head).toMatchObject({
      x0: a.x,
      y0: a.y,
      width: TRAIL_HEAD.width,
      glow: TRAIL_HEAD.glow,
    });
    expect(head?.color[3]).toBe(1);
    expect(head?.x1).toBeCloseTo(a.x + (b.x - a.x) * 0.5, 9);
    expect(head?.y1).toBeCloseTo(a.y + (b.y - a.y) * 0.5, 9);
    expect(head?.color.slice(0, 3)).toEqual([...ALERT_COLORS.attacker]);
    // It arrives with the comet: the whole hop at the moment the particle lands.
    const [full] = trail().lines(10 + MIN_TRAVEL_SECONDS + 1e-9, false);
    expect(full).toMatchObject({ x1: b.x, y1: b.y });
    expect(full?.width).toBeCloseTo(TRAIL_HEAD.width, 6);
  });

  it("cools from the head to the afterglow over 1.5 s and then stays", () => {
    const arrived = 10 + MIN_TRAVEL_SECONDS;
    const alphas: number[] = [];
    for (let s = 0; s <= TRAIL_COOL_SECONDS + 0.5; s += 0.05) {
      const lines = trail().lines(arrived + s, false);
      expect(lines).toHaveLength(1);
      alphas.push(lines[0]?.color[3] ?? -1);
    }
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual((alphas[i - 1] ?? 0) + 1e-12);
    }
    const mid = trail().lines(arrived + 0.5, false)[0];
    expect(mid?.color[3]).toBeGreaterThan(TRAIL_AFTERGLOW.alpha);
    expect(mid?.color[3]).toBeLessThan(1);
    expect(mid?.width).toBeGreaterThan(TRAIL_AFTERGLOW.width);
    expect(mid?.width).toBeLessThan(TRAIL_HEAD.width);
    const done = trail().lines(arrived + TRAIL_COOL_SECONDS, false)[0];
    expect(done).toMatchObject({ width: 2.6, glow: 8 });
    expect(done?.color[3]).toBeCloseTo(0.55, 9);
    expect(trail().lines(arrived + 600, false)[0]).toEqual(done);
  });

  it("with reduced motion is the whole afterglow from the start, no head and no decay", () => {
    const t = trail();
    expect(t.lines(9.99, true)).toEqual([]);
    const b = at(B);
    for (const phase of [10, 10.3, 11.1, 12, 200]) {
      const [only, ...rest] = t.lines(phase, true);
      expect(rest).toEqual([]);
      expect(only).toMatchObject({ x1: b.x, y1: b.y, width: 2.6, glow: 8 });
      expect(only?.color[3]).toBeCloseTo(0.55, 9);
    }
  });

  it("is pure: the same events and phase give the same lines and leave the trail alone", () => {
    const t = trail();
    const before = t.lines(10.7, false);
    expect(t.lines(10.7, false)).toEqual(before);
    t.lines(30, false);
    t.lines(10.7, true);
    expect(t.lines(10.7, false)).toEqual(before);
    expect(t.hopCount()).toBe(1);
  });
});

describe("the attack trail, hops", () => {
  it("counts a directed pair once, treats the reverse as another hop, ignores unknown nodes", () => {
    const t = new AttackTrail(layout);
    t.ingest([packet(100, A, B), packet(110, A, B), packet(120, B, A)]);
    expect(t.hopCount()).toBe(2);
    t.ingest([packet(130, A, "no-such-node"), packet(131, "no-such-node", B)]);
    expect(t.hopCount()).toBe(2);
  });

  it("ignores events that are not packets", () => {
    const t = new AttackTrail(layout);
    const alert: SimEvent = {
      k: "ids.alert",
      tick: 5,
      op: 1,
      technique: "T0886",
      legacyId: "",
      link: "l-dmz-hmi1",
      conduit: "c-dmz-ctrl",
      sensor: "baseline",
    };
    t.ingest([alert]);
    expect(t.hopCount()).toBe(0);
  });

  it("keeps at most 64 hops and evicts the oldest first; clear leaves none", () => {
    const ids = Object.keys(layout.nodes);
    const t = new AttackTrail(layout);
    const hops: [string, string][] = [];
    for (const a of ids) for (const b of ids) if (a !== b) hops.push([a, b]);
    expect(hops.length).toBeGreaterThan(TRAIL_MAX_HOPS + 1);
    hops.slice(0, TRAIL_MAX_HOPS).forEach(([from, to], i) => {
      t.ingest([packet(i, from, to)]);
    });
    expect(t.hopCount()).toBe(TRAIL_MAX_HOPS);
    const first = hops[0];
    const extra = hops[TRAIL_MAX_HOPS];
    if (!first || !extra) throw new Error("not enough node pairs");
    const phase = 1000;
    const drawn = (): string[] =>
      t.lines(phase, true).map((l) => `${l.x0},${l.y0},${l.x1},${l.y1}`);
    const firstKey = `${at(first[0]).x},${at(first[0]).y},${at(first[1]).x},${at(first[1]).y}`;
    expect(drawn()).toContain(firstKey);
    t.ingest([packet(500, extra[0], extra[1])]);
    expect(t.hopCount()).toBe(TRAIL_MAX_HOPS);
    expect(drawn()).not.toContain(firstKey);
    t.clear();
    expect(t.hopCount()).toBe(0);
    expect(t.lines(phase, false)).toEqual([]);
  });
});

describe("relighting a hop", () => {
  it("relights the head only when the new packet is 4 or more ticks after the last light", () => {
    expect(TRAIL_RELIGHT_MIN_TICKS).toBe(4);
    const settled = 10 + MIN_TRAVEL_SECONDS + TRAIL_COOL_SECONDS + 1;
    const t = new AttackTrail(layout);
    t.ingest([packet(100, A, B)]);
    // Long after: the afterglow only.
    expect(t.lines(settled, false)).toHaveLength(1);
    expect(t.lines(settled, false)[0]?.width).toBe(2.6);
    // A packet 4 ticks after it lights the head again, over the afterglow.
    const relit = new AttackTrail(layout);
    relit.ingest([packet(100, A, B), packet(200, A, B)]);
    const lines = relit.lines(20 + 0.4, false);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.width).sort()).toEqual([2.6, 4]);
    const head = lines.find((l) => l.width === 4);
    expect(head?.color[3]).toBe(1);
    // The folded packet leaves no trace: the hop looks as if it had only the first packet.
    const folded = new AttackTrail(layout);
    folded.ingest([packet(100, A, B), packet(103, A, B)]);
    const single = new AttackTrail(layout);
    single.ingest([packet(100, A, B)]);
    for (const phase of [10.2, 10.6, 11.4, 12.5, 40]) {
      expect(folded.lines(phase, false)).toEqual(single.lines(phase, false));
    }
  });

  it("never brightens a hop more than 3 times in any second, with a packet on it every tick", () => {
    const t = new AttackTrail(layout);
    const events: Packet[] = [];
    for (let tick = 100; tick <= 130; tick++) events.push(packet(tick, A, B));
    // Feed them as the app does: tick by tick, in order.
    t.ingest(events);
    const step = 0.02;
    const samples: number[] = [];
    for (let s = 9; s <= 20; s += step) {
      const lines = t.lines(s, false);
      samples.push(lines.reduce((m, l) => Math.max(m, l.color[3]), 0));
    }
    const rises: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] ?? 0) > (samples[i - 1] ?? 0) + 1e-9) rises.push(9 + i * step);
    }
    for (const r of rises) {
      expect(rises.filter((x) => x >= r && x < r + 1).length).toBeLessThanOrEqual(3);
    }
  });

  it("never brightens more than 3 times a second when packets arrive at the guard's own rate", () => {
    const t = new AttackTrail(layout);
    const events: Packet[] = [];
    // One packet every 5 ticks (just past the guard) for 8 s, each a short 2 tick hop.
    for (let tick = 100; tick < 180; tick += 5) events.push(packet(tick, A, B, tick + 2));
    t.ingest(events);
    const step = 0.02;
    const samples: number[] = [];
    for (let s = 9; s <= 22; s += step) {
      samples.push(t.lines(s, false).reduce((m, l) => Math.max(m, l.color[3]), 0));
    }
    const rises: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] ?? 0) > (samples[i - 1] ?? 0) + 1e-9) rises.push(9 + i * step);
    }
    for (const r of rises) {
      expect(rises.filter((x) => x >= r && x < r + 1).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("the trail in the view", () => {
  const index = networkIndex();
  const ctx = createViewContext(network, index, layout);

  it("is passed through untouched and never changes the links", () => {
    const t = new AttackTrail(layout);
    t.ingest([packet(100, A, B)]);
    const trail = t.lines(10.7, false);
    const plain = buildView(warmWorld(index), ctx);
    const withTrail = buildView(warmWorld(index), ctx, { trail });
    expect(plain.trail).toEqual([]);
    expect(withTrail.trail).toBe(trail);
    expect(withTrail.links).toEqual(plain.links);
    expect(withTrail.signals).toEqual(plain.signals);
    expect(withTrail.nodes).toEqual(plain.nodes);
    expect(withTrail.track).toEqual(plain.track);
    expect(withTrail.trains).toEqual(plain.trains);
  });
});

describe("the phishing kill chain", () => {
  it("is all lit, at afterglow, in one frame at 00:34", () => {
    const entry = catalog[0];
    if (!entry) throw new Error("no scenario");
    const session = createAttractSession({ scenario: entry.scenario, recording: entry.recording });
    const t = new AttackTrail(layout);
    for (let i = 0; i < 340; i++) {
      session.advance(1);
      t.ingest(session.drainEvents());
    }
    expect(session.elapsedTicks()).toBe(340);
    const phase = session.world().tick / 10;
    const lines = t.lines(phase, false);
    for (const id of ["l-net-mail", "l-mail-dispatch", "l-dispatch-dmz", "l-dmz-hmi1"]) {
      const link = network.links.find((l) => l.id === id);
      if (!link) throw new Error(`no link ${id}`);
      const a = at(link.a);
      const b = at(link.b);
      const hit = lines.find(
        (l) =>
          (l.x0 === a.x && l.y0 === a.y && l.x1 === b.x && l.y1 === b.y) ||
          (l.x0 === b.x && l.y0 === b.y && l.x1 === a.x && l.y1 === a.y),
      );
      expect(hit, id).toBeDefined();
      expect(hit?.width, id).toBeCloseTo(2.6, 9);
      expect(hit?.color[3], id).toBeCloseTo(0.55, 9);
    }
    // Nothing is a bright head any more.
    for (const l of lines) expect(l.color[3]).toBeCloseTo(0.55, 9);
  });
});
