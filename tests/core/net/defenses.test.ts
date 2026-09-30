import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { linkAllows } from "../../../src/core/net/defenses";
import type { TimedAction } from "../../../src/core/replay/recording";
import { type Action, isAction } from "../../../src/core/sim/actions";
import { DEFENSE_PLACEMENT_LATENCY_TICKS } from "../../../src/core/sim/constants";
import type { SimEvent } from "../../../src/core/sim/events";
import { cloneWorld, createWorld } from "../../../src/core/sim/world";
import { networkIndex, nodeOf, run, scenario, warmWorld } from "../../fixtures/attack";

const index = networkIndex();
const END = 30900;

const DMZ_TO_CONTROL = "c-dmz-ctrl";
const HMI_LINK = "l-dmz-hmi1";
const linkOf = (id: string) => {
  const link = network.links.find((l) => l.id === id);
  if (link === undefined) throw new Error(`no link ${id}`);
  return link;
};

function kinds<K extends SimEvent["k"]>(events: SimEvent[], k: K): Extract<SimEvent, { k: K }>[] {
  return events.filter((e): e is Extract<SimEvent, { k: K }> => e.k === k);
}

const place = (t: number, action: Extract<Action, { type: "defense.place" }>): TimedAction => ({
  t,
  a: action,
});

const firewallOn = (
  conduit: string,
  allow?: string[],
): Extract<Action, { type: "defense.place" }> =>
  allow === undefined
    ? { type: "defense.place", kind: "firewall", on: { conduit } }
    : { type: "defense.place", kind: "firewall", on: { conduit }, config: { allow } };

/** The tick the payload launched at `launchTick` lands on the far end of the hop. */
const hopLands = (launchTick: number, linkId: string): number =>
  launchTick + linkOf(linkId).latencyTicks;

const hmiLaunchTick = scenario.actions[3]?.t ?? 0;

describe("a firewall on a conduit (the tracer)", () => {
  it("without any defense the chain reaches the traffic management server", () => {
    const { world, events } = run(warmWorld(index), index, scenario.actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(true);
    expect(nodeOf(world, "dispatch-hmi-1").integrity).toBe(1);
    expect(kinds(events, "op.blocked")).toEqual([]);
  });

  it("blocks the payload at the boundary when it comes into force in flight", () => {
    // Placed so that it takes effect exactly when the hop to the console lands.
    const landing = hopLands(hmiLaunchTick, HMI_LINK);
    const actions = [
      ...scenario.actions,
      place(landing - DEFENSE_PLACEMENT_LATENCY_TICKS, firewallOn(DMZ_TO_CONTROL)),
    ];
    const { world, events } = run(warmWorld(index), index, actions, END);

    const blocked = kinds(events, "op.blocked");
    expect(blocked).toEqual([
      expect.objectContaining({
        technique: "T0886",
        link: HMI_LINK,
        at: "dmz-relay",
        tick: landing,
      }),
    ]);
    expect(linkOf(HMI_LINK).conduit).toBe(DMZ_TO_CONTROL);
    expect(nodeOf(world, "dispatch-hmi-1").integrity).toBe(0);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
    // The intruder still holds what it took before the boundary closed.
    expect(nodeOf(world, "dmz-relay").integrity).toBe(1);
  });

  it("keeps the path from being planned across a conduit that is already shut", () => {
    const actions = [...scenario.actions, place(hmiLaunchTick - 100, firewallOn(DMZ_TO_CONTROL))];
    const { world, events } = run(warmWorld(index), index, actions, END);
    const refused = kinds(events, "technique.rejected").filter(
      (e) => e.target === "dispatch-hmi-1",
    );
    expect(refused[0]?.reasons).toContain(
      "no permitted remote-services path from a compromised node to dispatch-hmi-1",
    );
    expect(kinds(events, "op.blocked")).toEqual([]);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
  });

  it("a restrictive allow-list that leaves the attacker's protocol out blocks just the same", () => {
    const actions = [
      ...scenario.actions,
      place(hmiLaunchTick - 100, firewallOn(DMZ_TO_CONTROL, ["historian-mirror"])),
    ];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
  });

  it("an allow-list that names the attacker's protocol lets it through", () => {
    const actions = [
      ...scenario.actions,
      place(hmiLaunchTick - 100, firewallOn(DMZ_TO_CONTROL, ["remote-services"])),
    ];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(true);
  });

  it("a firewall on another conduit leaves this boundary open", () => {
    const actions = [...scenario.actions, place(hmiLaunchTick - 100, firewallOn("c-net-vendor"))];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(true);
  });
});

describe("placement latency", () => {
  const fresh = () => createWorld(network, 1);

  it("places one instance per member link, all in force from placedAt plus the latency", () => {
    const { world, events } = run(fresh(), index, [place(5, firewallOn(DMZ_TO_CONTROL))], 6);
    const members = network.links.filter((l) => l.conduit === DMZ_TO_CONTROL).map((l) => l.id);
    expect(world.defenses.map((d) => d.link).sort()).toEqual(members.sort());
    for (const d of world.defenses) {
      expect(d).toMatchObject({ kind: "firewall", conduit: DMZ_TO_CONTROL, placedAt: 5 });
      expect(d.activeFrom).toBe(5 + DEFENSE_PLACEMENT_LATENCY_TICKS);
    }
    expect(kinds(events, "defense.placed")).toEqual([
      expect.objectContaining({ id: "d1", conduit: DMZ_TO_CONTROL, activeFrom: 25 }),
    ]);
  });

  it("does not block on the tick before activeFrom and blocks on activeFrom", () => {
    const { world } = run(fresh(), index, [place(5, firewallOn(DMZ_TO_CONTROL))], 5);
    const link = linkOf(HMI_LINK);
    const at = (tick: number) =>
      linkAllows(link, "remote-services", "dmz-relay", "dispatch-hmi-1", world, tick);
    const activeFrom = 5 + DEFENSE_PLACEMENT_LATENCY_TICKS;
    expect(at(activeFrom - 1)).toBe(true);
    expect(at(activeFrom)).toBe(false);
    expect(at(activeFrom + 500)).toBe(false);
  });

  it("does not touch a link outside the conduit, or a technique that does not travel", () => {
    const { world } = run(fresh(), index, [place(5, firewallOn(DMZ_TO_CONTROL))], 5);
    const tick = 1000;
    const other = linkOf("l-dispatch-dmz");
    expect(linkAllows(other, "remote-services", other.a, other.b, world, tick)).toBe(true);
    const shut = linkOf(HMI_LINK);
    expect(linkAllows(shut, null, shut.a, shut.b, world, tick)).toBe(true);
  });

  it("a protocol the link never carried stays refused with or without a defense", () => {
    const world = fresh();
    const link = linkOf(HMI_LINK);
    expect(linkAllows(link, "smtp", link.a, link.b, world, 10)).toBe(false);
  });
});

describe("what a defense placement may and may not be", () => {
  const good = { type: "defense.place", kind: "firewall", on: { conduit: DMZ_TO_CONTROL } };

  it("isAction takes a well-formed placement and refuses an extra key anywhere in it", () => {
    expect(isAction(good)).toBe(true);
    expect(isAction({ ...good, config: { allow: ["scada-proto"] } })).toBe(true);
    expect(isAction({ type: "defense.place", kind: "diode", on: { link: HMI_LINK } })).toBe(true);
    expect(isAction({ ...good, extra: 1 })).toBe(false);
    expect(isAction({ ...good, on: { conduit: DMZ_TO_CONTROL, link: HMI_LINK } })).toBe(false);
    expect(isAction({ ...good, on: { conduit: DMZ_TO_CONTROL, extra: 1 } })).toBe(false);
    expect(isAction({ ...good, on: {} })).toBe(false);
    expect(isAction({ ...good, on: { zone: "z-ctrl" } })).toBe(false);
    expect(isAction({ ...good, config: { extra: 1 } })).toBe(false);
    expect(isAction({ ...good, config: { direction: "both" } })).toBe(false);
    expect(isAction({ ...good, config: { allow: [1] } })).toBe(false);
    expect(isAction({ ...good, config: { allow: Array(33).fill("x") } })).toBe(false);
    expect(isAction({ ...good, kind: "honeypot" })).toBe(false);
    expect(isAction({ ...good, kind: undefined })).toBe(false);
    expect(
      isAction(JSON.parse('{"type":"defense.place","kind":"firewall","on":{"__proto__":"x"}}')),
    ).toBe(false);
  });

  it("refuses an unknown conduit or link with an event, and changes nothing", () => {
    const attempts: Extract<Action, { type: "defense.place" }>[] = [
      { type: "defense.place", kind: "firewall", on: { conduit: "c-nowhere" } },
      { type: "defense.place", kind: "diode", on: { link: "l-nowhere" } },
      // Not a conduit of links: zones and nodes are not valid targets either.
      { type: "defense.place", kind: "firewall", on: { conduit: "z-ctrl" } },
    ];
    for (const action of attempts) {
      const { world, events } = run(createWorld(network, 1), index, [place(1, action)], 2);
      expect(kinds(events, "action.rejected")).toEqual([
        expect.objectContaining({ reason: "unknown-target" }),
      ]);
      expect(world.defenses).toEqual([]);
      expect(world.defenseSeq).toBe(0);
    }
  });

  it("refuses a config that does not belong to its kind", () => {
    const attempts: Extract<Action, { type: "defense.place" }>[] = [
      {
        type: "defense.place",
        kind: "firewall",
        on: { link: HMI_LINK },
        config: { direction: "a-to-b" },
      },
      { type: "defense.place", kind: "diode", on: { link: HMI_LINK }, config: { allow: ["x"] } },
      { type: "defense.place", kind: "ids", on: { link: HMI_LINK }, config: { allow: [] } },
    ];
    for (const action of attempts) {
      const { world, events } = run(createWorld(network, 1), index, [place(1, action)], 2);
      expect(kinds(events, "action.rejected")).toEqual([
        expect.objectContaining({ reason: "invalid-defense" }),
      ]);
      expect(world.defenses).toEqual([]);
    }
  });

  it("does not stack an identical placement, and answers the repeat with an event", () => {
    const again = firewallOn(DMZ_TO_CONTROL);
    const { world, events } = run(
      createWorld(network, 1),
      index,
      [place(1, again), place(3, again)],
      4,
    );
    const members = network.links.filter((l) => l.conduit === DMZ_TO_CONTROL).length;
    expect(world.defenses).toHaveLength(members);
    expect(kinds(events, "action.rejected")).toEqual([
      expect.objectContaining({ reason: "already-placed", tick: 3 }),
    ]);
  });

  it("refuses a placement past the cap instead of growing the world", () => {
    const world = createWorld(network, 1);
    const links = network.links.filter((l) => l.conduit !== undefined);
    const actions: TimedAction[] = [];
    let t = 1;
    // Distinct allow-lists make each placement different, so none is a repeat.
    for (let n = 0; n < 60; n++) {
      for (const link of links.slice(0, 4)) {
        actions.push(
          place(t++, {
            type: "defense.place",
            kind: "firewall",
            on: { link: link.id },
            config: { allow: [`p${n}`] },
          }),
        );
      }
    }
    const { world: after, events } = run(world, index, actions, t);
    expect(after.defenses.length).toBeLessThanOrEqual(200);
    expect(kinds(events, "action.rejected").some((e) => e.reason === "defense-limit")).toBe(true);
  });

  it("cloneWorld copies defenses, so a step never edits the world it was given", () => {
    const { world } = run(
      createWorld(network, 1),
      index,
      [place(1, firewallOn(DMZ_TO_CONTROL))],
      2,
    );
    const copy = cloneWorld(world);
    copy.defenses[0]?.allow.push("x");
    if (copy.defenses[0] !== undefined) copy.defenses[0].activeFrom = 0;
    expect(world.defenses[0]?.allow).toEqual([]);
    expect(world.defenses[0]?.activeFrom).toBe(1 + DEFENSE_PLACEMENT_LATENCY_TICKS);
  });
});

describe("defenses cannot reach the railway", () => {
  const code = (path: string): string =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  const fields = (source: string, pattern: RegExp): string[] =>
    [...new Set([...source.matchAll(pattern)].map((m) => m[1] ?? ""))].sort();

  it("the defense module reads and writes only the defense list and its counter", () => {
    const source = code("src/core/net/defenses.ts");
    expect(fields(source, /\bworld\.(\w+)/g)).toEqual(["defenseSeq", "defenses"]);
    expect(fields(source, /\bworld\.(\w+)\s*(?:=|\+=|-=)(?!=)/g)).toEqual(["defenseSeq"]);
  });

  it("a placement changes nothing in the world except the defense list and its counter", () => {
    const before = createWorld(network, 3);
    const { world } = run(before, index, [place(1, firewallOn(DMZ_TO_CONTROL))], 2);
    const { defenses, defenseSeq, tick, ...rest } = world;
    const { defenses: d0, defenseSeq: s0, tick: t0, ...rest0 } = before;
    expect(rest).toEqual(rest0);
    expect([defenses.length > 0, defenseSeq, tick, d0, s0, t0]).toEqual([true, 1, 2, [], 0, 0]);
  });
});
