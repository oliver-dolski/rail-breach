import { describe, expect, it } from "vitest";
import attackCatalog from "../../../src/content/attack-ics.json";
import { network } from "../../../src/content/network";
import { techniques } from "../../../src/content/techniques";
import type { AttackCatalogue } from "../../../src/content/validate";
import { ContentError, validateTechniques } from "../../../src/content/validate";
import type { Effect, TechniqueDef } from "../../../src/core/attack/types";
import type { SimEvent } from "../../../src/core/sim/events";
import { buildIndex } from "../../../src/core/sim/model";
import { createWorld } from "../../../src/core/sim/world";
import { networkIndex, nodeOf, run, withoutProtocol } from "../../fixtures/attack";

/** The 13 techniques of this phase, in the order the definitions list them. */
const CURRENT_IDS = [
  "T0865",
  "T0822",
  "T0859",
  "T0886",
  "T0866",
  "T0840",
  "T1692.001",
  "T0836",
  "T1691.001",
  "T1692.002",
  "T0813",
  "T0829",
  "T0880",
];

const problemsOf = (check: () => void): string => {
  try {
    check();
  } catch (error) {
    if (error instanceof ContentError) return error.problems.join("\n");
    throw error;
  }
  return "";
};

const launchAt = (t: number, technique: string, target: string) => ({
  t,
  a: { type: "technique.launch" as const, technique, target },
});

// ---------------------------------------------------------------- one case per technique

interface Case {
  id: string;
  target: string;
  foothold: string[];
  discovered: string[];
  /** The route the payload must take, node by node. */
  path: string[];
  /** What the world shows on the target after a success. */
  shows: (node: ReturnType<typeof nodeOf>) => unknown;
  expected: unknown;
}

const CASES: Case[] = [
  {
    id: "T0865",
    target: "corp-ws-dispatch",
    foothold: [],
    discovered: [],
    path: ["internet", "corp-mail", "corp-ws-dispatch"],
    shows: (n) => n.integrity,
    expected: 1,
  },
  {
    id: "T0822",
    target: "vpn-gw",
    foothold: [],
    discovered: [],
    path: ["internet", "vpn-gw"],
    shows: (n) => n.integrity,
    expected: 1,
  },
  {
    id: "T0859",
    target: "il-tav",
    foothold: ["ctrl-eng-ws"],
    discovered: ["il-tav"],
    path: ["ctrl-eng-ws", "il-tav"],
    shows: (n) => n.integrity,
    expected: 1,
  },
  {
    id: "T0886",
    target: "dmz-relay",
    foothold: ["corp-ws-dispatch"],
    discovered: ["dmz-relay"],
    path: ["corp-ws-dispatch", "dmz-relay"],
    shows: (n) => n.integrity,
    expected: 1,
  },
  {
    id: "T0866",
    target: "dispatch-hmi-1",
    foothold: ["corp-ws-dispatch"],
    discovered: ["dispatch-hmi-1"],
    path: ["corp-ws-dispatch", "dmz-relay", "dispatch-hmi-1"],
    shows: (n) => n.integrity,
    expected: 2,
  },
  {
    id: "T1692.001",
    target: "il-tav",
    foothold: ["fep"],
    discovered: ["il-tav"],
    path: ["fep", "il-tav"],
    shows: (n) => n.cmdBlocked,
    expected: true,
  },
  {
    id: "T0836",
    target: "il-tav",
    foothold: ["mws-tav"],
    discovered: ["il-tav"],
    path: ["mws-tav", "il-tav"],
    shows: (n) => n.paramClampPermille,
    expected: 250,
  },
  {
    id: "T1691.001",
    target: "tms-server",
    foothold: ["dispatch-hmi-1"],
    discovered: ["tms-server"],
    path: ["dispatch-hmi-1", "tms-server"],
    shows: (n) => n.cmdBlocked,
    expected: true,
  },
  {
    id: "T1692.002",
    target: "dispatch-hmi-1",
    foothold: ["tms-server"],
    discovered: [],
    path: ["tms-server", "dispatch-hmi-1"],
    shows: (n) => n.view,
    expected: "spoofed",
  },
  {
    id: "T0813",
    target: "dispatch-hmi-2",
    foothold: ["tms-server"],
    discovered: [],
    path: ["tms-server", "dispatch-hmi-2"],
    shows: (n) => n.controlDenied,
    expected: true,
  },
  {
    id: "T0829",
    target: "tms-server",
    foothold: ["dispatch-hmi-1"],
    discovered: [],
    path: ["dispatch-hmi-1", "tms-server"],
    shows: (n) => n.view,
    expected: "frozen",
  },
  {
    id: "T0880",
    target: "il-vel",
    foothold: ["ctrl-eng-ws"],
    discovered: ["il-vel"],
    path: ["ctrl-eng-ws", "il-vel"],
    shows: (n) => n.availability,
    expected: "down",
  },
];

function prepared(c: Case, seed: number) {
  const world = createWorld(network, seed);
  for (const id of c.foothold) nodeOf(world, id).integrity = 1;
  for (const id of c.discovered) nodeOf(world, id).discovered = true;
  return world;
}

// ---------------------------------------------------------------- the definitions

describe("the 13 technique definitions", () => {
  const byId = (id: string): TechniqueDef => {
    const def = techniques.find((t) => t.id === id);
    if (def === undefined) throw new Error(`no technique ${id}`);
    return def;
  };

  it("resolve in buildIndex by current ID, and the legacy IDs resolve to the same definition", () => {
    const index = buildIndex(network, { techniques });
    expect(techniques.map((t) => t.id)).toEqual(CURRENT_IDS);
    for (const id of CURRENT_IDS) expect(index.techniques.get(id)?.id, id).toBe(id);
    const aliases = [
      ["T0855", "T1692.001"],
      ["T0803", "T1691.001"],
      ["T0856", "T1692.002"],
    ] as const;
    for (const [legacy, current] of aliases) {
      expect(index.techniques.get(legacy)).toBe(index.techniques.get(current));
      expect(index.techniques.get(legacy)).toBe(byId(current));
    }
    expect(index.techniques.size).toBe(CURRENT_IDS.length + aliases.length);
  });

  it("are accepted by validateTechniques, name and tactic taken from the catalogue", () => {
    expect(problemsOf(() => validateTechniques(techniques, network))).toBe("");
    const catalogued = new Map(attackCatalog.techniques.map((t) => [t.id, t]));
    for (const def of techniques) {
      const entry = catalogued.get(def.id);
      expect(def.name, def.id).toBe(entry?.name);
      expect(entry?.tactics, def.id).toContain(def.tactic);
      expect(def.legacyId, def.id).toBe(entry?.legacyId);
    }
  });

  it("each have effects, and only from the restrictive-only vocabulary", () => {
    const allowed = new Set<Effect["k"]>([
      "foothold",
      "discover",
      "blockCommands",
      "denyControl",
      "setView",
      "degrade",
      "clampParam",
    ]);
    for (const def of techniques) {
      expect(def.effects.length, def.id).toBeGreaterThan(0);
      for (const effect of def.effects) {
        expect(allowed.has(effect.k), `${def.id} ${effect.k}`).toBe(true);
      }
    }
  });

  it("need the right starting point: entry from outside, everything else from a foothold", () => {
    const entry = ["T0865", "T0822"];
    for (const def of techniques) {
      const fromExternal = def.pre.some((p) => p.k === "reach" && p.from === "external");
      const fromFoothold = def.pre.some(
        (p) => (p.k === "reach" && p.from === "foothold") || p.k === "targetFoothold",
      );
      if (entry.includes(def.id)) {
        expect(fromExternal, def.id).toBe(true);
      } else {
        expect(fromExternal, def.id).toBe(false);
        expect(fromFoothold, def.id).toBe(true);
      }
    }
  });

  it("cannot fire from a clean world: each impair, inhibit and impact technique is refused", () => {
    const index = networkIndex();
    const later = ["T1692.001", "T0836", "T1691.001", "T1692.002", "T0813", "T0829", "T0880"];
    for (const id of later) {
      const target = CASES.find((c) => c.id === id)?.target ?? "";
      const result = run(createWorld(network, 1), index, [launchAt(1, id, target)], 50);
      expect(
        result.events.some((e) => e.k === "technique.rejected"),
        id,
      ).toBe(true);
      expect(
        result.events.some((e) => e.k === "op.started"),
        id,
      ).toBe(false);
    }
  });

  it("carry no operational text: no CVE, no command, no product name", () => {
    const text = JSON.stringify(techniques.map((t) => [t.name, t.explain]));
    expect(text).not.toMatch(/CVE-\d|0day|shellcode|payload|sudo|powershell|cmd\.exe/i);
  });
});

// ---------------------------------------------------------------- propagation, ATK-04

describe("every travelling technique crosses the network hop by hop (ATK-04)", () => {
  const index = networkIndex();
  const latency = (link: string): number => index.net.linkById.get(link)?.latencyTicks ?? 0;

  it("covers the 12 techniques that travel; Network Connection Enumeration runs on one node", () => {
    expect(CASES.map((c) => c.id).sort()).toEqual(
      CURRENT_IDS.filter((id) => id !== "T0840").sort(),
    );
    expect(techniques.find((t) => t.id === "T0840")?.protocol).toBeNull();
  });

  for (const c of CASES) {
    it(`${c.id}: one packet per link, timed by its latency`, () => {
      const result = run(prepared(c, 1), index, [launchAt(1, c.id, c.target)], 800);
      const started = result.events.filter((e) => e.k === "op.started");
      expect(started).toMatchObject([{ technique: c.id, target: c.target, from: c.path[0] }]);

      const packets = result.events.filter(
        (e): e is Extract<SimEvent, { k: "packet" }> => e.k === "packet",
      );
      expect(packets.length, "one packet per hop").toBe(c.path.length - 1);
      let clock = 1;
      packets.forEach((packet, i) => {
        expect(packet.technique).toBe(c.id);
        expect([packet.from, packet.to]).toEqual([c.path[i], c.path[i + 1]]);
        expect(packet.tick, `hop ${i + 1} leaves when the last one arrived`).toBe(clock);
        expect(packet.arriveTick - packet.tick, `hop ${i + 1} takes the link latency`).toBe(
          latency(packet.link),
        );
        clock = packet.arriveTick;
      });
      expect(result.events.filter((e) => e.k === "op.blocked")).toEqual([]);
    });

    it(`${c.id}: over a few seeds it lands, and the target then shows it`, () => {
      let landed = 0;
      for (let seed = 0; seed < 40; seed++) {
        const result = run(prepared(c, seed), index, [launchAt(1, c.id, c.target)], 800);
        if (result.events.some((e) => e.k === "technique.succeeded")) {
          landed++;
          expect(c.shows(nodeOf(result.world, c.target)), `seed ${seed}`).toEqual(c.expected);
          expect(result.events.some((e) => e.k === "effect.applied")).toBe(true);
        } else {
          expect(
            result.events.some((e) => e.k === "technique.failed"),
            `seed ${seed}`,
          ).toBe(true);
        }
      }
      expect(landed).toBeGreaterThan(0);
    });
  }

  it("T0840 discovers the neighbourhood of a foothold without sending a packet", () => {
    const world = createWorld(network, 1);
    nodeOf(world, "corp-ws-dispatch").integrity = 1;
    const result = run(world, index, [launchAt(1, "T0840", "corp-ws-dispatch")], 200);
    expect(result.events.filter((e) => e.k === "packet")).toEqual([]);
    expect(nodeOf(result.world, "dmz-relay").discovered).toBe(true);
  });

  const lateral = CASES.find((c) => c.id === "T0866") as Case;

  it("a launch with no permitted path is refused with an explaining event", () => {
    const closed = networkIndex(withoutProtocol("l-dispatch-dmz", "remote-services"));
    const result = run(prepared(lateral, 1), closed, [launchAt(1, "T0866", lateral.target)], 50);
    expect(result.events.filter((e) => e.k === "technique.rejected")).toMatchObject([
      {
        technique: "T0866",
        target: lateral.target,
        reasons: [
          expect.stringMatching(/no permitted remote-services path from a compromised node/),
        ],
      },
    ]);
    expect(result.events.some((e) => e.k === "packet")).toBe(false);
  });

  it("a payload that finds its conduit closed at the next hop ends as op.blocked", () => {
    // The second link closes while the payload crosses it (it leaves at tick 5, arrives at 8).
    const late = networkIndex(withoutProtocol("l-dmz-hmi1", "remote-services"));
    const result = run(
      prepared(lateral, 1),
      (tick) => (tick < 6 ? index : late),
      [launchAt(1, "T0866", lateral.target)],
      200,
    );
    expect(result.events.filter((e) => e.k === "op.blocked")).toMatchObject([
      { technique: "T0866", link: "l-dmz-hmi1", at: "dmz-relay" },
    ]);
    expect(result.events.some((e) => e.k === "technique.succeeded")).toBe(false);
    expect(nodeOf(result.world, lateral.target).integrity).toBe(0);
    expect(result.world.ops).toEqual([]);
  });

  it("a payload whose first conduit closes while it crosses ends as op.blocked there", () => {
    const early = networkIndex(withoutProtocol("l-dispatch-dmz", "remote-services"));
    const result = run(
      prepared(lateral, 1),
      (tick) => (tick < 3 ? index : early),
      [launchAt(1, "T0866", lateral.target)],
      200,
    );
    expect(result.events.filter((e) => e.k === "op.blocked")).toMatchObject([
      { technique: "T0866", link: "l-dispatch-dmz", at: "corp-ws-dispatch" },
    ]);
    expect(result.events.filter((e) => e.k === "packet")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- validation of the new effects

describe("validateTechniques on the new effects and the catalogue", () => {
  const base = techniques[0] as TechniqueDef;
  const problems = (def: TechniqueDef, catalogue?: AttackCatalogue): string =>
    problemsOf(() => validateTechniques([def], network, catalogue));
  const withEffects = (effects: Effect[]): TechniqueDef => ({ ...base, effects });

  it("rejects a speed cap outside 0..1000 permille and a parameter the engine does not know", () => {
    for (const permille of [1001, -1, 12.5]) {
      expect(problems(withEffects([{ k: "clampParam", param: "speed", permille }]))).toMatch(
        /clampParam permille/,
      );
    }
    const odd = { k: "clampParam", param: "brake", permille: 500 } as unknown as Effect;
    expect(problems(withEffects([odd]))).toMatch(/parameter "brake"/);
  });

  it("rejects a view or availability state the engine does not handle", () => {
    const view = { k: "setView", state: "ok" } as unknown as Effect;
    const degrade = { k: "degrade", state: "ok" } as unknown as Effect;
    expect(problems(withEffects([view]))).toMatch(/setView state "ok"/);
    expect(problems(withEffects([degrade]))).toMatch(/degrade state "ok"/);
  });

  it("rejects a technique without effects and a non-positive recovery time", () => {
    expect(problems(withEffects([]))).toMatch(/has no effects/);
    expect(problems(withEffects([{ k: "denyControl", recoverTicks: 0 }]))).toMatch(/recoverTicks/);
  });

  it("rejects an id the catalogue lacks, a revoked one, a wrong name and a wrong tactic", () => {
    expect(problems({ ...base, id: "T9999" })).toMatch(/"T9999" is not in the ATT&CK catalogue/);
    expect(problems({ ...base, name: "Phishing" })).toMatch(/the catalogue says "Spearphishing/);
    expect(problems({ ...base, tactic: "impact" })).toMatch(/tactic "impact" is not one of/);
    const revoked: AttackCatalogue = {
      attackVersion: "19.2",
      techniques: attackCatalog.techniques.map((t) =>
        t.id === base.id ? { ...t, revoked: true } : t,
      ),
    };
    expect(problems(base, revoked)).toMatch(/is revoked in ATT&CK/);
  });

  it("accepts a legacy id only as a known alias of that very technique", () => {
    const spoof = techniques.find((t) => t.id === "T1692.002") as TechniqueDef;
    expect(problems({ ...spoof, legacyId: "T0855" })).toMatch(/not a known alias of it/);
    expect(problems({ ...spoof, legacyId: "T0001" })).toMatch(
      /"T0001" is not in the ATT&CK catalogue/,
    );
    expect(problems({ ...spoof, legacyId: undefined })).toMatch(
      /legacy id is none, the catalogue says T0856/,
    );
    expect(problems({ ...base, legacyId: "T0856" })).toMatch(
      /legacy id is T0856, the catalogue says none/,
    );
  });
});
