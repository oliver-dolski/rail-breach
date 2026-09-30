import type { Layout } from "../content/layout";
import type { Content } from "../content/types";
import { TICKS_PER_SECOND } from "../core/sim/constants";
import type { SimEvent } from "../core/sim/events";
import { ALERT_COLORS, NEUTRAL, type Rgba } from "./palette";

/**
 * Particles are renderer-only decoration derived from PacketEvents. They never
 * feed back into the simulation: dropping all of them changes nothing but the
 * picture, which is why they can simply be re-created after a lost GL context.
 */

/** Floats per particle: segment (4), timing (4), colour (4). */
export const PARTICLE_FLOATS = 12;

/** Hard cap on live one-shot particles; the oldest are overwritten. */
export const MAX_PARTICLES = 1536;

/** A packet that crosses a 2-tick link is invisible at real speed; show it this long at least. */
export const MIN_TRAVEL_SECONDS = 1.1;

/** Length of the comet: particles per packet, each a little behind the last. */
export const TRAIL_PARTICLES = 6;
const TRAIL_GAP_SECONDS = 0.05;

export interface Particle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Simulation time in seconds when it leaves p0. */
  start: number;
  /** Seconds to reach p1. */
  duration: number;
  size: number;
  loop: boolean;
  color: Rgba;
}

type PacketEvent = Extract<SimEvent, { k: "packet" }>;

/** The comet for one packet: same route, staggered starts, shrinking and fading. */
export function packetParticles(event: PacketEvent, layout: Layout): Particle[] {
  const from = layout.nodes[event.from];
  const to = layout.nodes[event.to];
  if (!from || !to) return [];
  const duration = Math.max((event.arriveTick - event.tick) / TICKS_PER_SECOND, MIN_TRAVEL_SECONDS);
  const [r, g, b] = ALERT_COLORS.attacker;
  const out: Particle[] = [];
  for (let i = 0; i < TRAIL_PARTICLES; i++) {
    const k = i / (TRAIL_PARTICLES - 1);
    out.push({
      x0: from.x,
      y0: from.y,
      x1: to.x,
      y1: to.y,
      start: event.tick / TICKS_PER_SECOND + i * TRAIL_GAP_SECONDS,
      duration,
      size: 5.6 - 3.2 * k,
      loop: false,
      color: [r, g, b, 1 - 0.65 * k],
    });
  }
  return out;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Quiet everyday traffic on every link, looping on the GPU. Deterministic from link ids. */
export function ambientParticles(content: Content, layout: Layout): Particle[] {
  const [r, g, b] = NEUTRAL.ambient;
  const out: Particle[] = [];
  for (const link of content.links) {
    const a = layout.nodes[link.a];
    const z = layout.nodes[link.b];
    if (!a || !z) continue;
    const length = Math.hypot(z.x - a.x, z.y - a.y);
    const duration = Math.max(2.5, length / 55);
    for (let i = 0; i < 2; i++) {
      const offset = hash(`${link.id}/${i}`) * duration;
      const forward = i === 0;
      out.push({
        x0: forward ? a.x : z.x,
        y0: forward ? a.y : z.y,
        x1: forward ? z.x : a.x,
        y1: forward ? z.y : a.y,
        start: -offset,
        duration,
        size: 1.9,
        loop: true,
        color: [r, g, b, 0.5],
      });
    }
  }
  return out;
}

/** Writes one particle into a float buffer at `offset`, in the layout particle.glsl reads. */
export function writeParticle(data: Float32Array, offset: number, p: Particle): void {
  data[offset] = p.x0;
  data[offset + 1] = p.y0;
  data[offset + 2] = p.x1;
  data[offset + 3] = p.y1;
  data[offset + 4] = p.start;
  data[offset + 5] = p.duration;
  data[offset + 6] = p.size;
  data[offset + 7] = p.loop ? 1 : 0;
  data[offset + 8] = p.color[0];
  data[offset + 9] = p.color[1];
  data[offset + 10] = p.color[2];
  data[offset + 11] = p.color[3];
}

/** Fixed-capacity ring of particle instances, laid out ready for upload. */
export class ParticleRing {
  readonly data = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
  private head = 0;
  private filled = 0;
  /** Bumped on every push, so the uploader knows when the GPU copy is stale. */
  version = 0;

  get count(): number {
    return this.filled;
  }

  push(p: Particle): void {
    writeParticle(this.data, this.head * PARTICLE_FLOATS, p);
    this.head = (this.head + 1) % MAX_PARTICLES;
    if (this.filled < MAX_PARTICLES) this.filled++;
    this.version++;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.data.fill(0);
    this.version++;
  }
}
