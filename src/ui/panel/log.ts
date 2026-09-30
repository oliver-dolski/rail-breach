import type { Layout } from "../../content/layout";
import type { EffectKind, TechniqueDef } from "../../core/attack/types";
import { TICKS_PER_SECOND } from "../../core/sim/constants";
import type { SimEvent } from "../../core/sim/events";

export type Tone = "attack" | "effect" | "rail" | "refusal" | "defense" | "detection";

export interface LogEntry {
  key: string;
  tick: number;
  tone: Tone;
  text: string;
}

export interface Names {
  node(id: string): string;
  /** The short on-map caption of a conduit, or its id when the layout has none. */
  conduit(id: string): string;
  technique(id: string): { name: string; explain: string; legacyId?: string } | undefined;
}

export function createNames(layout: Layout, techniques: readonly TechniqueDef[]): Names {
  const byId = new Map(techniques.map((t) => [t.id, t]));
  return {
    node: (id) => layout.nodes[id]?.label ?? id,
    conduit: (id) => layout.conduits[id] ?? id,
    technique: (id) => {
      const t = byId.get(id);
      if (t === undefined) return undefined;
      return t.legacyId === undefined
        ? { name: t.name, explain: t.explain }
        : { name: t.name, explain: t.explain, legacyId: t.legacyId };
    },
  };
}

/** One step of the attack chain as a chip: which technique and how it went. */
export interface ChainStep {
  op: number;
  technique: string;
  state: "running" | "done" | "failed" | "stopped";
}

/**
 * Refusals the interlocking hands out as ordinary queueing (a route is busy, a
 * section is occupied, a point is still moving) repeat every few seconds and
 * would drown the log. Only refusals caused by lost control are worth a line.
 */
const NEWSWORTHY_REFUSALS = [
  "command channel is blocked",
  "interlocking is out of service",
  "is disturbed",
];

/**
 * What the log says when an effect on a machine ends, in the words the operators would use.
 * One line per effect kind, so a restoration that clears several reads as several lines.
 */
const CLEARED_TEXT: Record<EffectKind, string> = {
  foothold: "intruder evicted",
  discover: "intruder's map forgotten",
  blockCommands: "command channel restored",
  denyControl: "operators regained control",
  setView: "operators' picture restored",
  degrade: "back in service",
  clampParam: "speed limit restored",
};

const KIND_NAME = { firewall: "Firewall", diode: "Data diode", ids: "IDS sensor" } as const;

/** What the log says when a defense action is refused; other refusals are not for the log. */
const DEFENSE_REFUSALS: Partial<
  Record<Extract<SimEvent, { k: "action.rejected" }>["reason"], string>
> = {
  "unknown-target": "no such conduit or link",
  "invalid-defense": "the settings do not fit that kind of defense",
  "already-placed": "the same defense is already there",
  "defense-limit": "too many defenses are placed",
  "unknown-defense": "no such defense to remove",
  "playbook-limit": "too many attack sequences are already running",
};

export function isNewsworthyRefusal(event: Extract<SimEvent, { k: "command.rejected" }>): boolean {
  if (event.by !== "ctc") return true;
  return NEWSWORTHY_REFUSALS.some((r) => event.reason.includes(r));
}

export function formatClock(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Turns the stream of simulation events into what the panel shows: a short log
 * (newest first), the chain of techniques, a one-sentence caption of the step in
 * progress and the latest interlocking refusal. Holds presentation state only.
 */
export class EventLog {
  private items: LogEntry[] = [];
  private chainSteps: ChainStep[] = [];
  private currentCaption = "";
  private latestRefusal: Extract<SimEvent, { k: "command.rejected" }> | undefined;
  private refusals = 0;
  private readonly told = new Set<string>();
  private seq = 0;

  constructor(
    private readonly names: Names,
    private readonly capacity = 14,
    private readonly alertCapacity = 8,
  ) {}

  reset(): void {
    this.items = [];
    this.chainSteps = [];
    this.currentCaption = "";
    this.latestRefusal = undefined;
    this.refusals = 0;
    this.told.clear();
  }

  entries(): readonly LogEntry[] {
    return this.items;
  }

  /** The simulation's own events, newest first: what the attacker did, what it did to the railway. */
  simulation(): readonly LogEntry[] {
    return this.items.filter((e) => e.tone !== "detection");
  }

  /** The IDS alerts alone, newest first, on their own list so they are never buried by simulation events. */
  alerts(): readonly LogEntry[] {
    return this.items.filter((e) => e.tone === "detection");
  }

  chain(): readonly ChainStep[] {
    return this.chainSteps;
  }

  caption(): string {
    return this.currentCaption;
  }

  refusal(): { latest: Extract<SimEvent, { k: "command.rejected" }> | undefined; total: number } {
    return { latest: this.latestRefusal, total: this.refusals };
  }

  ingest(events: readonly SimEvent[], startTick: number): void {
    for (const event of events) this.one(event, startTick);
  }

  private add(tick: number, startTick: number, tone: Tone, text: string): void {
    const at = `${formatClock(tick - startTick)}  `;
    this.items.unshift({ key: `e${this.seq++}`, tick, tone, text: at + text });
    // One store, two lanes: each lane drops its own oldest entry, so a flood of simulation
    // events can never push an alert out, nor the other way round.
    const isAlert = tone === "detection";
    const cap = isAlert ? this.alertCapacity : this.capacity;
    let kept = 0;
    for (let i = 0; i < this.items.length; i++) {
      if ((this.items[i]?.tone === "detection") !== isAlert) continue;
      kept++;
      if (kept > cap) {
        this.items.splice(i, 1);
        break;
      }
    }
  }

  private step(op: number): ChainStep | undefined {
    return this.chainSteps.find((s) => s.op === op);
  }

  private one(event: SimEvent, start: number): void {
    const n = this.names;
    switch (event.k) {
      case "op.started": {
        const t = n.technique(event.technique);
        this.chainSteps.push({ op: event.op, technique: event.technique, state: "running" });
        if (t) this.currentCaption = `${event.technique} ${t.name}: ${t.explain}`;
        this.add(
          event.tick,
          start,
          "attack",
          `${[event.technique, t?.name].filter(Boolean).join(" ")} launched against ${n.node(event.target)}`,
        );
        break;
      }
      case "technique.succeeded": {
        const s = this.step(event.op);
        if (s) s.state = "done";
        this.add(
          event.tick,
          start,
          "attack",
          `${event.technique} succeeded on ${n.node(event.node)}`,
        );
        break;
      }
      case "technique.failed": {
        const s = this.step(event.op);
        if (s) s.state = "failed";
        this.add(event.tick, start, "attack", `${event.technique} failed on ${n.node(event.node)}`);
        break;
      }
      case "technique.rejected":
        this.add(
          event.tick,
          start,
          "attack",
          `${event.technique} refused against ${n.node(event.target)}: ${event.reasons.join("; ")}`,
        );
        break;
      case "op.blocked": {
        const s = this.step(event.op);
        if (s) s.state = "stopped";
        this.add(
          event.tick,
          start,
          "attack",
          `${event.technique} stopped: link ${event.link} no longer allows it (at ${n.node(event.at)})`,
        );
        break;
      }
      case "effect.applied":
        if (event.effect === "blockCommands") {
          this.add(event.tick, start, "effect", `${n.node(event.node)}: command channel blocked`);
        } else if (event.effect === "denyControl") {
          this.add(event.tick, start, "effect", `${n.node(event.node)}: operators lost control`);
        }
        break;
      case "effect.cleared":
        this.add(
          event.tick,
          start,
          "effect",
          `${n.node(event.node)}: ${CLEARED_TEXT[event.effect]}`,
        );
        break;
      case "breach.assumed":
        this.add(
          event.tick,
          start,
          "attack",
          `${n.node(event.node)}: already held by the intruder (assumed breach)`,
        );
        break;
      case "command.rejected": {
        this.latestRefusal = event;
        this.refusals++;
        if (isNewsworthyRefusal(event)) {
          const key = `${event.il}|${event.reason}`;
          if (!this.told.has(key)) {
            this.told.add(key);
            this.add(
              event.tick,
              start,
              "refusal",
              `${event.il || "Interlocking"} refuses routes: ${event.reason} (fail-safe, signals stay at stop)`,
            );
          }
        }
        break;
      }
      case "defense.placed":
        this.add(
          event.tick,
          start,
          "defense",
          `${KIND_NAME[event.kind]} placed on ${event.conduit === "" ? (event.links[0] ?? "a link") : n.conduit(event.conduit)}, in force from ${formatClock(event.activeFrom - start)}`,
        );
        break;
      case "ids.alert": {
        const t = n.technique(event.technique);
        const where = event.conduit === "" ? event.link : n.conduit(event.conduit);
        const by = event.sensor === "baseline" ? "baseline monitoring" : `sensor ${event.sensor}`;
        this.add(
          event.tick,
          start,
          "detection",
          `IDS alert: ${[event.technique, t?.name].filter(Boolean).join(" ")} seen on ${where} (${by})`,
        );
        break;
      }
      case "defense.removed":
        this.add(event.tick, start, "defense", `Defense ${event.id} removed`);
        break;
      case "action.rejected": {
        const why = DEFENSE_REFUSALS[event.reason];
        if (why !== undefined) this.add(event.tick, start, "defense", `Defense refused: ${why}`);
        break;
      }
      case "interlocking.health":
        this.add(
          event.tick,
          start,
          "rail",
          event.health === "down"
            ? `${event.il} out of service: its signals go dark (fail-safe)`
            : `${event.il} back in service`,
        );
        break;
      case "train.stopped":
        if (event.cause === "signal") {
          this.add(
            event.tick,
            start,
            "rail",
            `Train ${event.train} stopped at signal ${event.signal ?? ""}`.trim(),
          );
        }
        break;
      case "train.overran":
        this.add(
          event.tick,
          start,
          "rail",
          `Train ${event.train} passed signal ${event.signal} after its lamp failed and stopped inside the overlap (fail-safe stop)`,
        );
        break;
      default:
        break;
    }
  }
}
