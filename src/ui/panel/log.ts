import type { Layout } from "../../content/layout";
import type { TechniqueDef } from "../../core/attack/types";
import { TICKS_PER_SECOND } from "../../core/sim/constants";
import type { SimEvent } from "../../core/sim/events";

export type Tone = "attack" | "effect" | "rail" | "refusal";

export interface LogEntry {
  key: string;
  tick: number;
  tone: Tone;
  text: string;
}

export interface Names {
  node(id: string): string;
  technique(id: string): { name: string; explain: string } | undefined;
}

export function createNames(layout: Layout, techniques: readonly TechniqueDef[]): Names {
  const byId = new Map(techniques.map((t) => [t.id, t]));
  return {
    node: (id) => layout.nodes[id]?.label ?? id,
    technique: (id) => {
      const t = byId.get(id);
      return t === undefined ? undefined : { name: t.name, explain: t.explain };
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
    if (this.items.length > this.capacity) this.items.length = this.capacity;
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
