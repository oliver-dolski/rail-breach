import type { EffectKind } from "../../core/attack/types";
import type { SimEvent } from "../../core/sim/events";
import type { World } from "../../core/sim/world";
import { h, setText } from "../dom";
import { timeToDetect } from "./detect";
import { formatClock, type Names } from "./log";

/**
 * The two-lane timeline: what the attacker did on one lane and what the defenders noticed
 * on the other, both placed by the tick since the start of the show. The gap between the
 * first attacker action and the first detection is the dwell time, shaded across both
 * lanes (and still growing while nothing has been noticed). It reads the event stream and
 * two clock fields of a snapshot; it never writes to the world, and a run started over or
 * a scenario switched clears it.
 *
 * The lanes do not span the whole show: they span the attack (see `axisTicks`), so the
 * first seconds of a chain are spread across the lane instead of piling into its left edge,
 * and marks of one lane never sit closer than MIN_GAP_PERMILLE.
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
  /** Position along the lane in permille of its span (`axisTicks`), kept MIN_GAP_PERMILLE from its neighbours. */
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
  /** The clock, in permille of the lane's span (`axisTicks`); it sits at the right edge after the attack. */
  nowPermille: number;
  /** How many ticks the lane spans from the start of the show: the attack, not the whole show. */
  axisTicks: number;
}

/**
 * The shortest stretch a lane spans: 30 s at 10 ticks a second (TICKS_PER_SECOND in core,
 * which the UI does not import; a test pins the equality).
 */
export const MIN_AXIS_TICKS = 300;

/** The least distance between two marks of one lane, in permille, so that dots do not merge. */
export const MIN_GAP_PERMILLE = 50;

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

/**
 * Spreads marks (already in tick order) so that neighbours are at least MIN_GAP_PERMILLE
 * apart: a forward pass pushes each mark past the one before it, then a backward pass from
 * the last mark (held at 1000) pulls each back to make room, never below 0.
 */
function keepApart(marks: { permille: number }[]): void {
  for (let i = 1; i < marks.length; i++) {
    const mark = marks[i];
    const before = marks[i - 1];
    if (mark && before) mark.permille = Math.max(mark.permille, before.permille + MIN_GAP_PERMILLE);
  }
  const last = marks[marks.length - 1];
  if (last) last.permille = Math.min(last.permille, 1000);
  for (let i = marks.length - 2; i >= 0; i--) {
    const mark = marks[i];
    const after = marks[i + 1];
    if (mark && after) {
      mark.permille = Math.max(0, Math.min(mark.permille, after.permille - MIN_GAP_PERMILLE));
    }
  }
}

export class Timeline {
  private readonly raw: (Omit<Mark, "permille"> & { order: number })[] = [];
  private seq = 0;
  /** Bumped on every reset, so the keys of one session never collide with the next one's. */
  private generation = 0;

  constructor(private readonly names: Names) {}

  reset(): void {
    this.raw.length = 0;
    this.seq = 0;
    this.generation++;
  }

  private technique(id: string): string {
    const def = this.names.technique(id);
    return def?.legacyId === undefined ? id : `${id} (was ${def.legacyId})`;
  }

  private add(lane: Lane, kind: MarkKind, tick: number, technique: string, label: string): void {
    const order = this.seq++;
    this.raw.push({
      key: `g${this.generation}m${order}`,
      order,
      lane,
      kind,
      tick,
      technique,
      label,
    });
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
   * lanes span the attack: at least MIN_AXIS_TICKS, and a quarter more than the latest mark
   * or closed dwell, never more than the show. The dwell is read off the world's own
   * clocks: first action to first alert, or to now while nothing has been noticed.
   */
  model(
    world: Pick<World, "tick" | "firstActionTick" | "detectedAt">,
    startTick: number,
    lengthTicks: number,
  ): TimelineModel {
    const closedEnd = world.firstActionTick > 0 && world.detectedAt > 0;
    const latest = Math.max(
      0,
      ...this.raw.map((m) => m.tick),
      closedEnd ? world.detectedAt - startTick : 0,
    );
    const axisTicks =
      lengthTicks <= 0
        ? 0
        : Math.min(lengthTicks, Math.max(MIN_AXIS_TICKS, Math.ceil((latest * 5) / 4)));

    const place = (lane: Lane): Mark[] => {
      const marks = this.raw
        .filter((m) => m.lane === lane)
        .map((m) => ({ ...m, permille: clampPermille(m.tick, axisTicks) }))
        .sort((a, b) => a.tick - b.tick || a.order - b.order);
      keepApart(marks);
      return marks.map(({ order: _order, ...mark }) => mark);
    };

    let dwell: Dwell | undefined;
    if (world.firstActionTick > 0) {
      const open = world.detectedAt === 0;
      const toTick = open ? world.tick : world.detectedAt;
      dwell = {
        fromTick: world.firstActionTick,
        toTick,
        ticks: toTick - world.firstActionTick,
        open,
        fromPermille: clampPermille(world.firstActionTick - startTick, axisTicks),
        toPermille: clampPermille(toTick - startTick, axisTicks),
      };
    }
    return {
      attacker: place("attacker"),
      detection: place("detection"),
      dwell,
      nowPermille: clampPermille(world.tick - startTick, axisTicks),
      axisTicks,
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
      setText(
        dwellText,
        `Time to detect: ${timeToDetect(world)}. The lanes span the first ${formatClock(model.axisTicks)}.`,
      );
    },
  };
}
