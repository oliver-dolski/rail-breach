import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { techniques } from "../../src/content/techniques";
import type { SimEvent } from "../../src/core/sim/events";
import { timeToDetect } from "../../src/ui/panel/detect";
import { createNames, EventLog } from "../../src/ui/panel/log";

const names = createNames(layout, techniques);

describe("the time-to-detect counter", () => {
  it("says there is nothing to time before the attacker acts", () => {
    expect(timeToDetect({ tick: 500, firstActionTick: 0, detectedAt: 0 })).toBe("no attack yet");
  });

  it("runs from the first action while nothing has been noticed", () => {
    expect(timeToDetect({ tick: 1300, firstActionTick: 1000, detectedAt: 0 })).toBe(
      "not noticed, 30 s since the first action",
    );
  });

  it("stops at the first alert and stays there as the clock goes on", () => {
    const at = (tick: number) => timeToDetect({ tick, firstActionTick: 1000, detectedAt: 1106 });
    expect(at(1106)).toBe("after 10 s");
    expect(at(9000)).toBe("after 10 s");
  });
});

describe("the log lines for defenses and alerts", () => {
  const log = () => new EventLog(names);

  it("tells an alert with the technique, where it was seen and by what", () => {
    const l = log();
    l.ingest(
      [
        {
          k: "ids.alert",
          tick: 130,
          op: 3,
          technique: "T0886",
          legacyId: "",
          link: "l-dmz-hmi1",
          conduit: "c-dmz-ctrl",
          sensor: "d2",
        },
        {
          k: "ids.alert",
          tick: 140,
          op: 3,
          technique: "T0886",
          legacyId: "",
          link: "l-mail-dc",
          conduit: "",
          sensor: "baseline",
        },
      ],
      100,
    );
    const [newest, older] = l.entries();
    expect(older).toMatchObject({ tone: "detection" });
    expect(older?.text).toContain("IDS alert: T0886 Remote Services seen on DMZ-Ctrl (sensor d2)");
    expect(newest?.text).toContain("seen on l-mail-dc (baseline monitoring)");
  });

  it("tells a placement and a removal, and why a defense was refused", () => {
    const l = log();
    const events: SimEvent[] = [
      {
        k: "defense.placed",
        tick: 110,
        id: "d1",
        kind: "firewall",
        conduit: "c-dmz-ctrl",
        links: ["l-dmz-hist", "l-dmz-hmi1"],
        activeFrom: 130,
      },
      { k: "defense.removed", tick: 150, id: "d1" },
      { k: "action.rejected", tick: 160, reason: "unknown-target" },
      { k: "action.rejected", tick: 170, reason: "unknown-node" },
    ];
    l.ingest(events, 100);
    const texts = l.entries().map((e) => e.text);
    // Newest first; the refusal of a node action is not a defense matter and stays out.
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("Defense refused: no such conduit or link");
    expect(texts[1]).toContain("Defense d1 removed");
    expect(texts[2]).toContain("Firewall placed on DMZ-Ctrl, in force from 00:03");
    for (const entry of l.entries()) expect(entry.tone).toBe("defense");
  });
});
