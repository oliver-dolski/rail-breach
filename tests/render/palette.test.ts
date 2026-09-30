import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import type { SimEvent } from "../../src/core/sim/events";
import {
  ALERT_COLORS,
  ALERT_HUES,
  hueDistance,
  hueOf,
  NEUTRAL,
  NODE_STYLES,
  type NodeVisualState,
  SIGNAL_COLORS,
  SIGNAL_HUES,
} from "../../src/render/palette";
import {
  ambientParticles,
  MAX_PARTICLES,
  MIN_TRAVEL_SECONDS,
  PARTICLE_FLOATS,
  ParticleRing,
  packetParticles,
  TRAIL_PARTICLES,
} from "../../src/render/particleRing";

const MIN_GAP_DEG = 40;

describe("the two hue families", () => {
  const signal = Object.values(SIGNAL_HUES);
  const alert = Object.values(ALERT_HUES);

  it("share no hue: every alert hue is at least 40 degrees from every signal hue", () => {
    for (const a of alert) {
      for (const s of signal)
        expect(hueDistance(a, s), `${a} vs ${s}`).toBeGreaterThanOrEqual(MIN_GAP_DEG);
    }
  });

  it("holds for the colours themselves, measured from their RGB, not only for the declared hues", () => {
    const measured = (rgb: readonly [number, number, number]) => {
      const h = hueOf(rgb);
      if (h === null) throw new Error("expected a coloured value");
      return h;
    };
    for (const [name, color] of Object.entries(SIGNAL_COLORS)) {
      const want = SIGNAL_HUES[name as keyof typeof SIGNAL_HUES];
      expect(hueDistance(measured(color), want), name).toBeLessThan(8);
    }
    for (const [name, color] of Object.entries(ALERT_COLORS)) {
      const want = ALERT_HUES[name as keyof typeof ALERT_HUES];
      expect(hueDistance(measured(color), want), name).toBeLessThan(8);
    }
    for (const a of Object.values(ALERT_COLORS)) {
      for (const s of Object.values(SIGNAL_COLORS)) {
        expect(hueDistance(measured(a), measured(s))).toBeGreaterThanOrEqual(MIN_GAP_DEG - 8);
      }
    }
  });

  it("keeps the alert hues apart from each other as well", () => {
    for (let i = 0; i < alert.length; i++) {
      for (let j = i + 1; j < alert.length; j++) {
        expect(hueDistance(alert[i] ?? 0, alert[j] ?? 0)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("leaves the map furniture hue-free, so only signals and alerts carry colour", () => {
    for (const [name, color] of Object.entries(NEUTRAL)) {
      expect(hueOf(color), name).toBeNull();
    }
  });
});

describe("node state is told by shape as well as colour", () => {
  const states: NodeVisualState[] = ["normal", "compromised", "degraded", "lost"];

  it("gives each of the four states its own shape and its own colour", () => {
    expect(new Set(states.map((s) => NODE_STYLES[s].shape)).size).toBe(4);
    expect(new Set(states.map((s) => NODE_STYLES[s].color.join(","))).size).toBe(4);
  });

  it("never paints a node in a signal colour", () => {
    for (const s of states) {
      const h = hueOf(NODE_STYLES[s].color);
      if (h === null) continue;
      for (const sig of Object.values(SIGNAL_HUES)) {
        expect(hueDistance(h, sig), s).toBeGreaterThanOrEqual(MIN_GAP_DEG - 8);
      }
    }
  });
});

type PacketEvent = Extract<SimEvent, { k: "packet" }>;

const packet: PacketEvent = {
  k: "packet",
  tick: 7362,
  op: 0,
  technique: "T0865",
  link: "l-net-mail",
  from: "internet",
  to: "corp-mail",
  arriveTick: 7367,
};

describe("packet particles", () => {
  it("run along the conduit from the sending machine to the receiving one", () => {
    const from = layout.nodes[packet.from];
    const to = layout.nodes[packet.to];
    const comet = packetParticles(packet, layout);
    expect(comet).toHaveLength(TRAIL_PARTICLES);
    for (const p of comet) {
      expect([p.x0, p.y0]).toEqual([from?.x, from?.y]);
      expect([p.x1, p.y1]).toEqual([to?.x, to?.y]);
      expect(p.loop).toBe(false);
    }
  });

  it("start at the packet's tick, each a little behind the last, and stay visible long enough", () => {
    const comet = packetParticles(packet, layout);
    expect(comet[0]?.start).toBeCloseTo(packet.tick / 10, 9);
    for (let i = 1; i < comet.length; i++) {
      expect(comet[i]?.start ?? 0).toBeGreaterThan(comet[i - 1]?.start ?? 0);
    }
    // The link takes half a second; showing it for that long would be a blink.
    expect((packet.arriveTick - packet.tick) / 10).toBeLessThan(MIN_TRAVEL_SECONDS);
    for (const p of comet) expect(p.duration).toBeGreaterThanOrEqual(MIN_TRAVEL_SECONDS);
  });

  it("are attacker traffic, in the alert hue family and never in a signal hue", () => {
    for (const p of packetParticles(packet, layout)) {
      const h = hueOf([p.color[0], p.color[1], p.color[2]]);
      expect(h).not.toBeNull();
      for (const s of Object.values(SIGNAL_HUES)) {
        expect(hueDistance(h ?? 0, s)).toBeGreaterThanOrEqual(MIN_GAP_DEG - 8);
      }
      expect(hueDistance(h ?? 0, ALERT_HUES.attacker)).toBeLessThan(8);
    }
  });

  it("are dropped for a link the layout does not know, instead of drawing at the origin", () => {
    expect(packetParticles({ ...packet, from: "nowhere" }, layout)).toEqual([]);
  });

  it("every packet link in the recorded chain has both ends on the map", () => {
    const linked = new Set(network.links.flatMap((l) => [l.a, l.b]));
    for (const id of linked) expect(layout.nodes[id], id).toBeDefined();
  });
});

describe("the particle ring", () => {
  const sample = packetParticles(packet, layout)[0];
  if (!sample) throw new Error("no sample particle");

  it("caps the live count: pushing past the limit overwrites the oldest", () => {
    const ring = new ParticleRing();
    for (let i = 0; i < MAX_PARTICLES * 2 + 5; i++) ring.push({ ...sample, start: i });
    expect(ring.count).toBe(MAX_PARTICLES);
    expect(ring.data.length).toBe(MAX_PARTICLES * PARTICLE_FLOATS);
    // Slot 4 of the first particle is its start time: the very first pushes are gone.
    const starts = new Set<number>();
    for (let i = 0; i < MAX_PARTICLES; i++) starts.add(ring.data[i * PARTICLE_FLOATS + 4] ?? -1);
    expect(starts.has(0)).toBe(false);
    expect(starts.has(MAX_PARTICLES * 2 + 4)).toBe(true);
  });

  it("writes the layout particle.glsl reads, and clears to nothing", () => {
    const ring = new ParticleRing();
    ring.push(sample);
    expect(ring.count).toBe(1);
    expect(Array.from(ring.data.subarray(0, 4))).toEqual([
      Math.fround(sample.x0),
      Math.fround(sample.y0),
      Math.fround(sample.x1),
      Math.fround(sample.y1),
    ]);
    const version = ring.version;
    ring.clear();
    expect(ring.count).toBe(0);
    expect(ring.version).toBeGreaterThan(version);
    expect(ring.data.every((v) => v === 0)).toBe(true);
  });

  it("is decoration: the same events always give the same particles", () => {
    const a = new ParticleRing();
    const b = new ParticleRing();
    for (const p of packetParticles(packet, layout)) {
      a.push(p);
      b.push(p);
    }
    expect(a.data).toEqual(b.data);
  });
});

describe("ambient traffic", () => {
  it("is deterministic, loops, stays neutral and covers every link in both directions", () => {
    const a = ambientParticles(network, layout);
    const b = ambientParticles(network, layout);
    expect(b).toEqual(a);
    expect(a).toHaveLength(network.links.length * 2);
    for (const p of a) {
      expect(p.loop).toBe(true);
      expect(hueOf([p.color[0], p.color[1], p.color[2]])).toBeNull();
    }
  });
});
