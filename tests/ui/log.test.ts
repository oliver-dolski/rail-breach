import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { techniques } from "../../src/content/techniques";
import type { SimEvent } from "../../src/core/sim/events";
import { createNames, EventLog, formatClock, isNewsworthyRefusal } from "../../src/ui/panel/log";
import { networkIndex, run, scenario, warmWorld } from "../fixtures/attack";

const names = createNames(layout, techniques);
const index = networkIndex();
const START = 100;

type Rejected = Extract<SimEvent, { k: "command.rejected" }>;
const rejected = (tick: number, over: Partial<Rejected> = {}): Rejected => ({
  k: "command.rejected",
  tick,
  il: "IL-VEL",
  route: "R-VEL-dn-main",
  by: "ctc",
  reason: "conflicts with locked route R-L2-dn",
  ...over,
});

describe("the event log", () => {
  it("keeps the dispatcher's ordinary queueing out of the log but shows it on the refusal surface", () => {
    const log = new EventLog(names);
    const noise = Array.from({ length: 40 }, (_, i) => rejected(START + i * 50));
    log.ingest(noise, START);
    expect(log.entries()).toEqual([]);
    expect(log.refusal().total).toBe(40);
    expect(log.refusal().latest?.reason).toBe("conflicts with locked route R-L2-dn");
  });

  it("tells a lost command channel once per interlocking, however often it repeats", () => {
    const log = new EventLog(names);
    const blocked = (tick: number, il: string) =>
      rejected(tick, { il, reason: "command channel is blocked" });
    log.ingest(
      [
        blocked(200, "IL-VEL"),
        blocked(250, "IL-VEL"),
        blocked(300, "IL-TAV"),
        blocked(350, "IL-VEL"),
      ],
      START,
    );
    expect(log.entries()).toHaveLength(2);
    expect(
      log
        .entries()
        .map((e) => e.text)
        .join("\n"),
    ).toContain("IL-TAV refuses routes");
    expect(log.refusal().total).toBe(4);
  });

  it("always shows a refusal of an operator command", () => {
    expect(isNewsworthyRefusal(rejected(1, { by: "operator" }))).toBe(true);
    expect(isNewsworthyRefusal(rejected(1, { by: "ctc" }))).toBe(false);
    expect(
      isNewsworthyRefusal(rejected(1, { by: "ctc", reason: "section sec-L2_dn is disturbed" })),
    ).toBe(true);
  });

  it("describes a train that ran past a dark signal as a fail-safe stop, never as danger or a crash", () => {
    const log = new EventLog(names);
    log.ingest([{ k: "train.overran", tick: 300, train: "SV-DN#2", signal: "S-L2-dn" }], START);
    const text = log.entries()[0]?.text ?? "";
    expect(text).toContain("fail-safe stop");
    expect(text).toContain("inside the overlap");
    expect(text).not.toMatch(/collision|crash|danger|SPAD|derail/i);
  });

  it("follows the chain: a chip per operation, running until it succeeds", () => {
    const log = new EventLog(names);
    log.ingest(
      [
        {
          k: "op.started",
          tick: 120,
          op: 0,
          technique: "T0865",
          target: "corp-ws-dispatch",
          from: "internet",
        },
      ],
      START,
    );
    expect(log.chain()).toEqual([{ op: 0, technique: "T0865", state: "running" }]);
    expect(log.caption()).toMatch(/^T0865 Spearphishing Attachment: /);
    log.ingest(
      [
        {
          k: "technique.succeeded",
          tick: 170,
          op: 0,
          technique: "T0865",
          node: "corp-ws-dispatch",
        },
      ],
      START,
    );
    expect(log.chain()[0]?.state).toBe("done");
  });

  it("keeps the newest entries first and at most its capacity", () => {
    const log = new EventLog(names, 5);
    const events: SimEvent[] = Array.from({ length: 12 }, (_, i) => ({
      k: "train.stopped" as const,
      tick: 100 + i,
      train: `T${i}`,
      cause: "signal" as const,
      signal: "S-X",
    }));
    log.ingest(events, START);
    expect(log.entries()).toHaveLength(5);
    expect(log.entries()[0]?.text).toContain("T11");
  });

  it("forgets everything on reset, so a second round starts clean", () => {
    const log = new EventLog(names);
    log.ingest([rejected(200, { reason: "command channel is blocked" })], START);
    log.reset();
    expect(log.entries()).toEqual([]);
    expect(log.refusal()).toEqual({ latest: undefined, total: 0 });
    log.ingest([rejected(300, { reason: "command channel is blocked" })], START);
    expect(log.entries()).toHaveLength(1);
  });

  it("formats the clock as minutes and seconds of show time", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(59)).toBe("00:05");
    expect(formatClock(605)).toBe("01:00");
    expect(formatClock(-30)).toBe("00:00");
  });
});

describe("the log for the recorded show", () => {
  const { events } = run(warmWorld(index), index, scenario.actions, scenario.durationTicks);
  const log = new EventLog(names, 100);
  log.ingest(events, scenario.startTick);
  const text = log.entries().map((e) => e.text);

  it("reads as the attack chain followed by the fail-safe response", () => {
    const joined = [...text].reverse().join("\n");
    expect(joined).toMatch(/T0865 Spearphishing Attachment launched against Dispatcher WS/);
    expect(joined).toMatch(/Traffic mgmt: command channel blocked/);
    expect(joined).toMatch(/Traffic mgmt: operators lost control/);
    expect(joined).toMatch(/refuses routes: command channel is blocked/);
  });

  it("is short: the many ordinary refusals do not reach it", () => {
    // 19 refusals at the recorded start; most are a train's dispatch request being retried.
    const refusals = events.filter((e) => e.k === "command.rejected").length;
    expect(refusals).toBeGreaterThan(10);
    const told = text.filter((line) => /refuses routes/.test(line));
    expect(told.length).toBeGreaterThan(0);
    expect(told.length).toBeLessThan(refusals);
    expect(told.length).toBeLessThanOrEqual(3); // once per interlocking
    expect(log.entries().length).toBeLessThan(40);
  });

  it("uses plain hyphens and ASCII only", () => {
    for (const line of text) {
      expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
