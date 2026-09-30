import { describe, expect, it } from "vitest";
import { network } from "../../../src/content/network";
import type { Content, SignalDef } from "../../../src/content/types";
import { ContentError, validateContent } from "../../../src/content/validate";
import { emergencyBrakeDistance } from "../../../src/core/rail/kinematics";
import { buildIndex } from "../../../src/core/sim/model";
import { step } from "../../../src/core/sim/step";
import { createWorld } from "../../../src/core/sim/world";

const TWO_HOURS_TICKS = 2 * 60 * 60 * 10;

function withSignal(id: string, patch: Partial<SignalDef>): Content {
  return {
    ...network,
    tracks: {
      ...network.tracks,
      signals: network.tracks.signals.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    },
  };
}

function problemsOf(content: Content): readonly string[] {
  try {
    validateContent(content);
  } catch (error) {
    if (error instanceof ContentError) return error.problems;
    throw error;
  }
  return [];
}

describe("the fictional network", () => {
  it("validates", () => {
    expect(problemsOf(network)).toEqual([]);
  });

  it("has a mainline with a branch, six stations, three interlockings and the surrounding networks", () => {
    const stations = new Set(network.tracks.blocks.map((b) => b.id.split("_")[0]));
    for (const station of ["HAR", "TAV", "VEL", "CRE", "DUN", "PEL"]) {
      expect(stations.has(station), station).toBe(true);
    }
    expect(network.interlockings).toHaveLength(3);
    expect(network.tracks.points.map((p) => p.id)).toEqual(["J1", "J2"]);
    const kinds = new Set(network.nodes.map((n) => n.kind));
    for (const kind of [
      "external",
      "mail-server",
      "domain-controller",
      "vpn-gateway",
      "vendor-jump-host",
      "scada-server",
      "hmi",
      "historian",
      "front-end-processor",
      "interlocking",
      "object-controller",
    ] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it("uses plain ASCII ids compared by exact equality", () => {
    const ids = [
      ...network.zones.map((z) => z.id),
      ...network.nodes.map((n) => n.id),
      ...network.links.map((l) => l.id),
      ...network.conduits.map((c) => c.id),
      ...network.interlockings.map((i) => i.id),
      ...network.tracks.blocks.flatMap((b) => [b.id, b.section]),
      ...network.tracks.signals.map((s) => s.id),
      ...network.tracks.points.map((p) => p.id),
      ...network.tracks.routes.map((r) => r.id),
      ...network.tracks.services.map((s) => s.id),
    ];
    for (const id of ids) expect(id, id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries no address, no url and no non-ASCII text", () => {
    const text = JSON.stringify(network);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe("track validation", () => {
  it("rejects a signal overlap shorter than the emergency braking distance at line speed", () => {
    const need = emergencyBrakeDistance(network.tracks.vmaxDmPerTick);
    expect(problemsOf(withSignal("S-L1-dn", { overlapDm: need - 1 })).join("\n")).toMatch(
      /S-L1-dn.*shorter than the emergency braking distance/,
    );
    expect(problemsOf(withSignal("S-L1-dn", { overlapDm: need }))).toEqual([]);
  });

  it("rejects an overlap that does not fit in the block beyond the signal", () => {
    expect(problemsOf(withSignal("S-HAR-dn", { overlapDm: 60000 })).join("\n")).toMatch(
      /does not fit/,
    );
  });

  it("rejects dangling references", () => {
    const dangling: Content = {
      ...network,
      tracks: {
        ...network.tracks,
        routes: network.tracks.routes.map((r) =>
          r.id === "R-L1-dn" ? { ...r, blocks: ["NOWHERE"] } : r,
        ),
        signals: network.tracks.signals.map((s) =>
          s.id === "S-TAV-dn" ? { ...s, controller: "no-such-node" } : s,
        ),
      },
    };
    const text = problemsOf(dangling).join("\n");
    expect(text).toMatch(/unknown block "NOWHERE"/);
    expect(text).toMatch(/unknown controller "no-such-node"/);
  });

  it("rejects a service that takes a turn no route allows", () => {
    const broken: Content = {
      ...network,
      tracks: {
        ...network.tracks,
        routes: network.tracks.routes.filter((r) => r.id !== "R-VEL-dn-br"),
      },
    };
    expect(problemsOf(broken).join("\n")).toMatch(/SV-BR-DN.*no route allows it/);
  });

  it("rejects a point leg that its route never uses", () => {
    const broken: Content = {
      ...network,
      tracks: {
        ...network.tracks,
        routes: network.tracks.routes.map((r) =>
          r.id === "R-VEL-dn-main" ? { ...r, points: [{ point: "J1", pos: "reverse" }] } : r,
        ),
      },
    };
    expect(problemsOf(broken).join("\n")).toMatch(/never uses that leg/);
  });
});

describe("baseline timetable", () => {
  it("runs two simulated hours with trains moving and no permanent deadlock", () => {
    const index = buildIndex(network);
    let world = createWorld(network, 1);
    const spawned = new Map<string, number>();
    const arrived = new Map<string, number>();
    let overruns = 0;
    let moving = 0;

    for (let i = 0; i < TWO_HOURS_TICKS; i++) {
      const result = step(world, [], index);
      world = result.world;
      for (const e of result.events) {
        if (e.k === "train.spawned") spawned.set(e.train, e.tick);
        if (e.k === "train.arrived") arrived.set(e.train, e.tick);
        if (e.k === "train.overran") overruns += 1;
      }
      if (world.trains.some((t) => t.speedDmPerTick > 0)) moving += 1;
    }

    expect(overruns).toBe(0);
    expect(spawned.size).toBeGreaterThanOrEqual(30);
    // every train that had a fair chance to finish did finish
    const stuck = [...spawned.entries()].filter(
      ([id, tick]) => tick <= TWO_HOURS_TICKS - 12000 && !arrived.has(id),
    );
    expect(stuck).toEqual([]);
    // the four services all completed at least one full run
    for (const service of ["SV-DN", "SV-UP", "SV-BR-DN", "SV-BR-UP"]) {
      expect(
        [...arrived.keys()].some((id) => id.startsWith(`${service}#`)),
        service,
      ).toBe(true);
    }
    // trains spent most of the run moving, they did not sit idle
    expect(moving).toBeGreaterThan(TWO_HOURS_TICKS * 0.8);
    // each service released as many departures as its timetable asks for
    const released = new Map(world.services.map((s) => [s.id, s.released]));
    for (const def of network.tracks.services) {
      const due = Math.min(
        def.count,
        Math.floor((TWO_HOURS_TICKS - def.firstTick) / def.headwayTicks) + 1,
      );
      expect(released.get(def.id) ?? 0, def.id).toBeGreaterThanOrEqual(due - 1);
    }
  });
});
