import type { Layout } from "../content/layout";
import { TICKS_PER_SECOND } from "../core/sim/constants";
import type { SimEvent } from "../core/sim/events";
import { ALERT_COLORS } from "./palette";
import { MIN_TRAVEL_SECONDS } from "./particleRing";
import type { LineInstance } from "./view";

/**
 * The path the intruder took, kept lit. Like the alert flashes this is presentation state: the
 * UI feeds packet events in and asks which lines to draw at the phase it is drawing. Nothing
 * here reaches the world, and the lines are a pure function of the packet ticks and the phase.
 *
 * A hop is one directed node pair. A packet in flight is a bright head that grows from the
 * sender with the comet and arrives with it; after arrival it cools to an afterglow that stays
 * until the show starts over, so the whole kill chain is visible in one frame. A hop used again
 * is relit, but not closer than TRAIL_RELIGHT_MIN_TICKS behind its last light, so a busy hop
 * cannot flash faster than 2.5 times a second. With reduced motion there is no head and no
 * decay: the afterglow from the moment the first packet starts.
 */
export const TRAIL_MAX_HOPS = 64;
export const TRAIL_HEAD = { width: 4, glow: 14, alpha: 1 } as const;
export const TRAIL_AFTERGLOW = { width: 2.6, glow: 8, alpha: 0.55 } as const;
export const TRAIL_COOL_SECONDS = 1.5;
export const TRAIL_RELIGHT_MIN_TICKS = 4;

/** How sharply the cooling falls: e^-3 of the way is left at the end, which the ease then removes. */
const COOL_RATE = 3;

type PacketEvent = Extract<SimEvent, { k: "packet" }>;

interface Light {
  /** Simulation seconds when the packet leaves the sender. */
  start: number;
  /** Seconds to reach the receiver. */
  duration: number;
}

interface Hop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The first packet on this hop: after it has arrived the whole hop stays lit. */
  first: Light;
  /** The newest packet that was allowed to relight the hop. */
  last: Light;
  /** Tick of the newest light, for the relight guard. */
  litTick: number;
}

/** 1 right after arrival, 0 once the cooling is over, falling exponentially in between. */
function coolness(seconds: number): number {
  if (seconds <= 0) return 1;
  if (seconds >= TRAIL_COOL_SECONDS) return 0;
  const tail = Math.exp(-COOL_RATE);
  return (Math.exp((-COOL_RATE * seconds) / TRAIL_COOL_SECONDS) - tail) / (1 - tail);
}

function line(
  hop: Hop,
  x1: number,
  y1: number,
  width: number,
  glow: number,
  alpha: number,
): LineInstance {
  const [r, g, b] = ALERT_COLORS.attacker;
  return { x0: hop.x0, y0: hop.y0, x1, y1, width, glow, dash: 0, color: [r, g, b, alpha] };
}

/** The whole hop at afterglow strength. */
function afterglow(hop: Hop): LineInstance {
  return line(
    hop,
    hop.x1,
    hop.y1,
    TRAIL_AFTERGLOW.width,
    TRAIL_AFTERGLOW.glow,
    TRAIL_AFTERGLOW.alpha,
  );
}

/** The head of one light at `phase`: growing while in flight, cooling to the afterglow after. */
function lightLine(hop: Hop, light: Light, phase: number): LineInstance | undefined {
  const elapsed = phase - light.start;
  if (elapsed < 0) return undefined;
  if (elapsed < light.duration) {
    const f = elapsed / light.duration;
    if (f <= 0) return undefined;
    return line(
      hop,
      hop.x0 + (hop.x1 - hop.x0) * f,
      hop.y0 + (hop.y1 - hop.y0) * f,
      TRAIL_HEAD.width,
      TRAIL_HEAD.glow,
      TRAIL_HEAD.alpha,
    );
  }
  const k = coolness(elapsed - light.duration);
  const mix = (cool: number, hot: number): number => cool + (hot - cool) * k;
  return line(
    hop,
    hop.x1,
    hop.y1,
    mix(TRAIL_AFTERGLOW.width, TRAIL_HEAD.width),
    mix(TRAIL_AFTERGLOW.glow, TRAIL_HEAD.glow),
    mix(TRAIL_AFTERGLOW.alpha, TRAIL_HEAD.alpha),
  );
}

export class AttackTrail {
  /** Insertion ordered, so the oldest hop is the first key. */
  private readonly hops = new Map<string, Hop>();

  constructor(private readonly layout: Layout) {}

  clear(): void {
    this.hops.clear();
  }

  hopCount(): number {
    return this.hops.size;
  }

  ingest(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.k !== "packet") continue;
      this.light(event);
    }
  }

  private light(event: PacketEvent): void {
    const from = this.layout.nodes[event.from];
    const to = this.layout.nodes[event.to];
    if (!from || !to) return;
    // The same duration the comet uses, so the lit line and the particle arrive together.
    const light: Light = {
      start: event.tick / TICKS_PER_SECOND,
      duration: Math.max((event.arriveTick - event.tick) / TICKS_PER_SECOND, MIN_TRAVEL_SECONDS),
    };
    const key = `${event.from}>${event.to}`;
    const known = this.hops.get(key);
    if (known) {
      // A packet right behind the last one is folded into it.
      if (event.tick - known.litTick < TRAIL_RELIGHT_MIN_TICKS) return;
      known.last = light;
      known.litTick = event.tick;
      return;
    }
    this.hops.set(key, {
      x0: from.x,
      y0: from.y,
      x1: to.x,
      y1: to.y,
      first: light,
      last: light,
      litTick: event.tick,
    });
    if (this.hops.size > TRAIL_MAX_HOPS) {
      const oldest = this.hops.keys().next().value;
      if (oldest !== undefined) this.hops.delete(oldest);
    }
  }

  /**
   * The lines to draw at `phaseSeconds`. A reused hop shows its newest head over the afterglow
   * of the first packet once that has arrived. Pure: nothing here changes the trail.
   */
  lines(phaseSeconds: number, reducedMotion: boolean): LineInstance[] {
    const out: LineInstance[] = [];
    for (const hop of this.hops.values()) {
      if (reducedMotion) {
        if (phaseSeconds >= hop.first.start) out.push(afterglow(hop));
        continue;
      }
      // Between the moment a relight is queued and the moment it starts, the older light still shows.
      const newest = phaseSeconds >= hop.last.start ? hop.last : hop.first;
      if (newest !== hop.first && phaseSeconds >= hop.first.start + hop.first.duration) {
        out.push(afterglow(hop));
      }
      const head = lightLine(hop, newest, phaseSeconds);
      if (head) out.push(head);
    }
    return out;
  }
}
