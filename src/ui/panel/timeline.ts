import type { EffectKind } from "../../core/attack/types";
import type { SimEvent } from "../../core/sim/events";
import type { World } from "../../core/sim/world";
import { h, setText } from "../dom";
import { timeToDetect } from "./detect";
import type { Names } from "./log";

/**
 * The two-lane timeline: what the attacker did on one lane and what the defenders noticed
 * on the other, both placed by the tick since the start of the show. The gap between the
 * first attacker action and the first detection is the dwell time, shaded across both
 * lanes (and still growing while nothing has been noticed). It reads the event stream and
 * two clock fields of a snapshot; it never writes to the world, and a run started over or
 * a scenario switched clears it.
 */

export type Lane = "attacker" | "detection";

/** Kinds of mark: a technique starting, a lasting effect it had, an assumed breach, an alert. */
export type MarkKind = "launch" | "impact" | "breach" | "alert";

export interface Mark {
  key: string;
  lane: Lane;
  kind: MarkKind;
  /** Ticks since the start of the show. */
  tick: number;
  /** Position along the lane in permille of the show's length. */
  permille: number;
  /** The technique (current id, and the pre-v19 one when there is one), or "" for a breach. */
  technique: string;
  label: string;
}

export interface Dwell {
  fromTick: number;
  toTick: number;
  ticks: number;
  /** True while nothing has been noticed: the gap runs up to now and is still growing. */
  open: boolean;
  fromPermille: number;
  toPermille: number;
}

export interface TimelineModel {
  attacker: Mark[];
  detection: Mark[];
  dwell: Dwell | undefined;
  /** The clock, in permille of the show's length. */
  nowPermille: number;
}

/** Effects that are only the intruder getting around; the timeline marks what they did, not that. */
const QUIET_EFFECTS: readonly EffectKind[] = ["foothold", "discover"];

const EFFECT_TEXT: Record<EffectKind, string> = {
  foothold: "foothold",
  discover: "network mapped",
  blockCommands: "command channel blocked",
  denyControl: "operators lost control",
  setView: "operators' picture disturbed",
  degrade: "taken out of service",
  clampParam: "speed limit lowered",
};

const clampPermille = (tick: number, length: number): number =>
  length <= 0 ? 0 : Math.max(0, Math.min(1000, Math.round((tick * 1000) / length)));

export class Timeline {
  private readonly raw: (Omit<Mark, "permille"> & { order: number })[] = [];
  private seq = 0;

  constructor(private readonly names: Names) {}

  reset(): void {
    this.raw.length = 0;
    this.seq = 0;
  }

  private technique(id: string): string {
    const def = this.names.technique(id);
    return def?.legacyId === undefined ? id : `${id} (was ${def.legacyId})`;
  }

  private add(lane: Lane, kind: MarkKind, tick: number, technique: string, label: string): void {
    const order = this.seq++;
    this.raw.push({ key: `m${order}`, order, lane, kind, tick, technique, label });
  }

  ingest(events: readonly SimEvent[], startTick: number): void {
    const n = this.names;
    for (const e of events) {
      const at = e.tick - startTick;
      if (e.k === "op.started") {
        const name = n.technique(e.technique)?.name;
        this.add(
          "attacker",
          "launch",
          at,
          this.technique(e.technique),
          `${this.technique(e.technique)}${name === undefined ? "" : ` ${name}`} against ${n.node(e.target)}`,
        );
      } else if (e.k === "effect.applied" && !QUIET_EFFECTS.includes(e.effect)) {
        this.add(
          "attacker",
          "impact",
          at,
          this.technique(e.technique),
          `${this.technique(e.technique)}: ${n.node(e.node)}, ${EFFECT_TEXT[e.effect]}`,
        );
      } else if (e.k === "breach.assumed") {
        this.add("attacker", "breach", at, "", `Assumed breach: ${n.node(e.node)} already held`);
      } else if (e.k === "ids.alert") {
        const where = e.conduit === "" ? e.link : n.conduit(e.conduit);
        this.add(
          "detection",
          "alert",
          at,
          this.technique(e.technique),
          `IDS alert: ${this.technique(e.technique)} seen on ${where}`,
        );
      }
    }
  }

  /**
   * The timeline as of `world`, over a show that lasts `lengthTicks` from `startTick`. The
   * dwell is read off the world's own clocks: first action to first alert, or to now while
   * nothing has been noticed.
   */
  model(
    world: Pick<World, "tick" | "firstActionTick" | "detectedAt">,
    startTick: number,
    lengthTicks: number,
  ): TimelineModel {
    const place = (lane: Lane): Mark[] =>
      this.raw
        .filter((m) => m.lane === lane)
        .map((m) => ({ ...m, permille: clampPermille(m.tick, lengthTicks) }))
        .sort((a, b) => a.tick - b.tick || a.order - b.order)
        .map(({ order: _order, ...mark }) => mark);

    let dwell: Dwell | undefined;
    if (world.firstActionTick > 0) {
      const open = world.detectedAt === 0;
      const toTick = open ? world.tick : world.detectedAt;
      dwell = {
        fromTick: world.firstActionTick,
        toTick,
        ticks: toTick - world.firstActionTick,
        open,
        fromPermille: clampPermille(world.firstActionTick - startTick, lengthTicks),
        toPermille: clampPermille(toTick - startTick, lengthTicks),
      };
    }
    return {
      attacker: place("attacker"),
      detection: place("detection"),
      dwell,
      nowPermille: clampPermille(world.tick - startTick, lengthTicks),
    };
  }
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface TimelineView {
  update(model: TimelineModel, world: Pick<World, "tick" | "firstActionTick" | "detectedAt">): void;
}

/**
 * Draws the model into the two lanes. Marks are kept by key, so a frame that changes
 * nothing writes nothing. Text and titles are set as text and attributes only, and the
 * positions go through the style object, which the strict CSP allows.
 */
export function createTimelineView(doc: Document): TimelineView {
  const lanes: Record<Lane, HTMLElement> = {
    attacker: need(doc, "tl-attacker"),
    detection: need(doc, "tl-detection"),
  };
  const dwellText = need(doc, "tl-dwell");
  const cursors = [need(doc, "tl-now-attacker"), need(doc, "tl-now-detection")];
  const bands = [need(doc, "tl-band-attacker"), need(doc, "tl-band-detection")];
  const shown = new Map<string, HTMLElement>();

  const place = (el: HTMLElement, permille: number): void => {
    const left = `${permille / 10}%`;
    if (el.style.left !== left) el.style.left = left;
  };

  return {
    update(model, world) {
      const wanted = new Set<string>();
      for (const lane of ["attacker", "detection"] as const) {
        for (const mark of model[lane]) {
          wanted.add(mark.key);
          let el = shown.get(mark.key);
          if (el === undefined) {
            el = h(doc, "span", {
              class: `tl-mark tl-${mark.kind}`,
              "data-key": mark.key,
              title: mark.label,
              "aria-label": mark.label,
              role: "img",
            });
            lanes[mark.lane].append(el);
            shown.set(mark.key, el);
          }
          place(el, mark.permille);
        }
      }
      for (const [key, el] of shown) {
        if (wanted.has(key)) continue;
        el.remove();
        shown.delete(key);
      }

      for (const cursor of cursors) place(cursor, model.nowPermille);
      for (const band of bands) {
        if (model.dwell === undefined) {
          band.hidden = true;
          continue;
        }
        band.hidden = false;
        place(band, model.dwell.fromPermille);
        const width = `${Math.max(0, model.dwell.toPermille - model.dwell.fromPermille) / 10}%`;
        if (band.style.width !== width) band.style.width = width;
        band.setAttribute("data-open", model.dwell.open ? "true" : "false");
      }
      setText(dwellText, `Time to detect: ${timeToDetect(world)}`);
    },
  };
}
