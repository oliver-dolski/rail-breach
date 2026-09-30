import { TICKS_PER_SECOND } from "../core/sim/constants";
import type { SimEvent } from "../core/sim/events";

/**
 * How an IDS alert shows on the map. An alert is an event, not world state, so the lit
 * links are presentation state kept here, next to the particle ring: the UI feeds events
 * in and asks how bright each link is at the phase it is drawing. Nothing here reaches
 * the world, and the brightness is a pure function of the alert ticks and the phase.
 *
 * Each alert starts one pulse. Pulses on one link are at least FLASH_MIN_GAP_TICKS
 * apart, so a busy link cannot flicker faster than 2.5 times a second, below the 3 a
 * second that is the most a flashing element should ever do. After the pulse the link
 * stays faintly lit for FLASH_HOLD_TICKS so the viewer can still find it. With reduced
 * motion there is no pulsing at all: one steady glow that fades out.
 */
export const FLASH_TICKS = 6;
export const FLASH_MIN_GAP_TICKS = 4;
export const FLASH_HOLD_TICKS = 80;
export const MAX_FLASHES_PER_SECOND = 3;

/** Flashes per second the pulse train can reach at most, for the test that pins the limit. */
export const MAX_FLASH_RATE = TICKS_PER_SECOND / FLASH_MIN_GAP_TICKS;

export interface AlertLevel {
  link: string;
  /** 0 (unlit) to 1 (brightest). */
  level: number;
}

/** One pulse: rises and falls once over FLASH_TICKS, peak in the middle. */
function pulse(since: number): number {
  if (since < 0 || since >= FLASH_TICKS) return 0;
  const s = Math.sin((Math.PI * since) / FLASH_TICKS);
  return s * s;
}

/** The brightness of a link whose accepted pulses began at `starts` (ascending), at `phase`. */
export function flashLevel(
  starts: readonly number[],
  phase: number,
  reducedMotion: boolean,
): number {
  const last = starts.at(-1);
  if (last === undefined || phase < (starts[0] ?? last)) return 0;
  if (reducedMotion) {
    // One steady glow from the first alert still in view, fading out: no pulsing at all.
    const first = starts[0] ?? last;
    const age = phase - first;
    return Math.max(0, 0.7 * (1 - age / (FLASH_HOLD_TICKS + (last - first))));
  }
  let level = 0;
  for (const start of starts) level = Math.max(level, pulse(phase - start));
  const since = phase - last;
  const hold = since < 0 || since >= FLASH_HOLD_TICKS ? 0 : 0.3 * (1 - since / FLASH_HOLD_TICKS);
  return Math.max(level, hold);
}

export class AlertFlashes {
  private readonly byLink = new Map<string, number[]>();

  clear(): void {
    this.byLink.clear();
  }

  ingest(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.k !== "ids.alert") continue;
      const starts = this.byLink.get(event.link) ?? [];
      const last = starts.at(-1);
      // A pulse that would start too close behind the last one is folded into it.
      if (last !== undefined && event.tick - last < FLASH_MIN_GAP_TICKS) continue;
      starts.push(event.tick);
      // Only the newest pulses can still be in view; the hold follows the newest one.
      while (starts.length > 3) starts.shift();
      this.byLink.set(event.link, starts);
    }
  }

  levels(phase: number, reducedMotion: boolean): AlertLevel[] {
    const out: AlertLevel[] = [];
    for (const [link, starts] of this.byLink) {
      const level = flashLevel(starts, phase, reducedMotion);
      if (level > 0) out.push({ link, level });
    }
    return out;
  }
}
