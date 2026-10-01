import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import { linkAllows } from "../../../src/core/net/defenses";
import { runOutcome } from "../../../src/core/replay/counterfactual";
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
    // The refusal says a defense closed the path, so a comparison can count it.
    expect(refused[0]?.byDefense).toBe(true);
    expect(kinds(events, "op.blocked")).toEqual([]);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
  });

  it("a launch refused with no defense in force carries no byDefense key", () => {
    const launch: TimedAction = {
      t: 1,
      a: { type: "technique.launch", technique: "T0886", target: "dispatch-hmi-1" },
    };
    const { events } = run(createWorld(network, 1), index, [launch], 3);
    const refused = kinds(events, "technique.rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reasons.length).toBeGreaterThan(0);
    expect("byDefense" in (refused[0] ?? {})).toBe(false);
  });

  it("an outcome counts only the refusals a defense caused", () => {
    const actions = [...scenario.actions, place(hmiLaunchTick - 100, firewallOn(DMZ_TO_CONTROL))];
    const defended = runOutcome(warmWorld(index), index, actions, END);
    const flagged = kinds(run(warmWorld(index), index, actions, END).events, "technique.rejected");
    expect(defended.refusedByDefense).toBe(flagged.filter((e) => e.byDefense === true).length);
    expect(defended.refusedByDefense).toBeGreaterThan(0);
    expect(defended.refused).toBe(flagged.length);
    expect(defended.firstBlockedTick).toBeGreaterThan(0);

    const open = runOutcome(warmWorld(index), index, scenario.actions, END);
    expect(open.refusedByDefense).toBe(0);
    expect(open.firstBlockedTick).toBe(0);
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
    expect(fields(source, /\bworld\.(\w+)\s*(?:=|\+=|-=)(?!=)/g)).toEqual([
      "defenseSeq",
      "defenses",
    ]);
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

type PlaceAction = Extract<Action, { type: "defense.place" }>;
const diodeOn = (conduit: string, direction: "a-to-b" | "b-to-a"): PlaceAction => ({
  type: "defense.place",
  kind: "diode",
  on: { conduit },
  config: { direction },
});

describe("a data diode", () => {
  const settle = DEFENSE_PLACEMENT_LATENCY_TICKS + 1;
  const link = linkOf(HMI_LINK);

  it("lets data pass the way it is set to and stops the reverse, on the same link", () => {
    const onLink = (direction: "a-to-b" | "b-to-a"): PlaceAction => ({
      type: "defense.place",
      kind: "diode",
      on: { link: HMI_LINK },
      config: { direction },
    });
    const towardsB = run(createWorld(network, 1), index, [{ t: 1, a: onLink("a-to-b") }], settle);
    const permits = (w: typeof towardsB.world, from: string, to: string) =>
      linkAllows(link, "remote-services", from, to, w, settle);
    expect(permits(towardsB.world, link.a, link.b)).toBe(true);
    expect(permits(towardsB.world, link.b, link.a)).toBe(false);

    const towardsA = run(createWorld(network, 1), index, [{ t: 1, a: onLink("b-to-a") }], settle);
    expect(permits(towardsA.world, link.a, link.b)).toBe(false);
    expect(permits(towardsA.world, link.b, link.a)).toBe(true);
  });

  it("is in force only from activeFrom, like every defense", () => {
    const { world } = run(
      createWorld(network, 1),
      index,
      [{ t: 1, a: diodeOn(DMZ_TO_CONTROL, "b-to-a") }],
      1,
    );
    const activeFrom = 1 + DEFENSE_PLACEMENT_LATENCY_TICKS;
    const crossing = (tick: number) =>
      linkAllows(link, "remote-services", link.a, link.b, world, tick);
    expect(crossing(activeFrom - 1)).toBe(true);
    expect(crossing(activeFrom)).toBe(false);
  });

  it("carries the legitimate telemetry in its direction while it stops the attacker's way in", () => {
    // Zone A is the DMZ, zone B the control centre: b-to-a lets data go out to the DMZ.
    const { world } = run(
      createWorld(network, 1),
      index,
      [{ t: 1, a: diodeOn(DMZ_TO_CONTROL, "b-to-a") }],
      settle,
    );
    const hist = linkOf("l-dmz-hist");
    expect(linkAllows(hist, "historian-mirror", "historian", "dmz-relay", world, settle)).toBe(
      true,
    );
    expect(linkAllows(hist, "historian-mirror", "dmz-relay", "historian", world, settle)).toBe(
      false,
    );
    expect(linkAllows(link, "remote-services", "dmz-relay", "dispatch-hmi-1", world, settle)).toBe(
      false,
    );
  });

  it("stops the phishing chain at the boundary when it lets data out only", () => {
    const actions = [
      ...scenario.actions,
      place(hmiLaunchTick - 100, diodeOn(DMZ_TO_CONTROL, "b-to-a")),
    ];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "dispatch-hmi-1").integrity).toBe(0);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(false);
  });

  it("stops a payload in flight when it comes into force, as op.blocked", () => {
    const landing = hopLands(hmiLaunchTick, HMI_LINK);
    const actions = [
      ...scenario.actions,
      place(landing - DEFENSE_PLACEMENT_LATENCY_TICKS, diodeOn(DMZ_TO_CONTROL, "b-to-a")),
    ];
    const { events } = run(warmWorld(index), index, actions, END);
    expect(kinds(events, "op.blocked")).toEqual([
      expect.objectContaining({ link: HMI_LINK, at: "dmz-relay", tick: landing }),
    ]);
  });

  it("set the other way round it lets the attacker's direction through", () => {
    const actions = [
      ...scenario.actions,
      place(hmiLaunchTick - 100, diodeOn(DMZ_TO_CONTROL, "a-to-b")),
    ];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(true);
  });

  it("on a conduit, is set between its zones however each link happens to be written", () => {
    // The same link written the other way round: its first end is now in zone B.
    const flipped = {
      ...network,
      links: network.links.map((l) => (l.id === HMI_LINK ? { ...l, a: l.b, b: l.a } : l)),
    };
    const { world } = run(
      createWorld(flipped, 1),
      networkIndex(flipped),
      [{ t: 1, a: diodeOn(DMZ_TO_CONTROL, "a-to-b") }],
      settle,
    );
    const written = flipped.links.find((l) => l.id === HMI_LINK);
    if (written === undefined) throw new Error("no link");
    // Zone A (DMZ) to zone B (control centre) is still dmz-relay to dispatch-hmi-1.
    expect(
      linkAllows(written, "remote-services", "dmz-relay", "dispatch-hmi-1", world, settle),
    ).toBe(true);
    expect(
      linkAllows(written, "remote-services", "dispatch-hmi-1", "dmz-relay", world, settle),
    ).toBe(false);
    expect(world.defenses.find((d) => d.link === HMI_LINK)?.direction).toBe("b-to-a");
  });

  it("and a firewall on the same link must both agree", () => {
    const base: TimedAction[] = [
      { t: 1, a: diodeOn(DMZ_TO_CONTROL, "a-to-b") },
      { t: 2, a: firewallOn(DMZ_TO_CONTROL, ["remote-services"]) },
    ];
    const lenient = run(createWorld(network, 1), index, base, 2 + settle);
    expect(linkAllows(link, "remote-services", link.a, link.b, lenient.world, 2 + settle)).toBe(
      true,
    );
    const strictActions = [...base, { t: 3, a: firewallOn(DMZ_TO_CONTROL) }];
    const strict = run(createWorld(network, 1), index, strictActions, 3 + settle);
    expect(linkAllows(link, "remote-services", link.a, link.b, strict.world, 3 + settle)).toBe(
      false,
    );
  });
});

describe("an IDS sensor", () => {
  it("never narrows a link", () => {
    const sensor: PlaceAction = {
      type: "defense.place",
      kind: "ids",
      on: { conduit: DMZ_TO_CONTROL },
    };
    const actions = [...scenario.actions, place(hmiLaunchTick - 100, sensor)];
    const { world } = run(warmWorld(index), index, actions, END);
    expect(nodeOf(world, "tms-server").cmdBlocked).toBe(true);
    expect(world.defenses.every((d) => d.kind === "ids")).toBe(true);
  });
});

describe("removing a defense", () => {
  const remove = (t: number, id: string): TimedAction => ({ t, a: { type: "defense.remove", id } });

  it("takes every instance of the placement away and says so", () => {
    const actions = [place(1, firewallOn(DMZ_TO_CONTROL)), remove(40, "d1")];
    const { world, events } = run(createWorld(network, 1), index, actions, 41);
    expect(world.defenses).toEqual([]);
    expect(kinds(events, "defense.removed")).toEqual([
      { k: "defense.removed", tick: 40, id: "d1" },
    ]);
  });

  it("reopens the path: the same chain that was stopped now gets through", () => {
    // Right after the warm-up, long before the console is attacked.
    const early = scenario.startTick + 5;
    const stopped = run(
      warmWorld(index),
      index,
      [...scenario.actions, place(early, firewallOn(DMZ_TO_CONTROL))],
      END,
    );
    expect(nodeOf(stopped.world, "tms-server").cmdBlocked).toBe(false);

    const reopened = run(
      warmWorld(index),
      index,
      [...scenario.actions, place(early, firewallOn(DMZ_TO_CONTROL)), remove(early + 60, "d1")],
      END,
    );
    expect(reopened.world.defenses).toEqual([]);
    expect(nodeOf(reopened.world, "tms-server").cmdBlocked).toBe(true);
  });

  it("refuses an id that is not placed, without touching the others", () => {
    const actions = [place(1, firewallOn(DMZ_TO_CONTROL)), remove(5, "d9")];
    const { world, events } = run(createWorld(network, 1), index, actions, 6);
    expect(kinds(events, "action.rejected")).toEqual([
      expect.objectContaining({ reason: "unknown-defense", tick: 5 }),
    ]);
    expect(world.defenses.length).toBeGreaterThan(0);
  });

  it("isAction takes an id and nothing else", () => {
    expect(isAction({ type: "defense.remove", id: "d1" })).toBe(true);
    expect(isAction({ type: "defense.remove" })).toBe(false);
    expect(isAction({ type: "defense.remove", id: 1 })).toBe(false);
    expect(isAction({ type: "defense.remove", id: "d1", extra: true })).toBe(false);
  });
});

describe("local restoration and defenses are separate mechanisms", () => {
  it("restoring a node leaves every placed defense where it is", () => {
    const actions: TimedAction[] = [
      place(1, firewallOn(DMZ_TO_CONTROL)),
      { t: 30, a: { type: "restore", node: "dispatch-hmi-1" } },
      { t: 31, a: { type: "restore", node: "tms-server" } },
    ];
    const { world } = run(createWorld(network, 1), index, actions, 40);
    const members = network.links.filter((l) => l.conduit === DMZ_TO_CONTROL).length;
    expect(world.defenses).toHaveLength(members);
    expect(world.defenseSeq).toBe(1);
  });
});
