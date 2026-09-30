/// <reference types="node" />
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTACK_VERSION,
  buildCatalog,
  CURRENT_IDS,
  LEGACY_IDS,
  SOURCE_SHA256,
  serialise,
} from "../../../scripts/build-attack.mjs";
import attackCatalog from "../../../src/content/attack-ics.json";
import { network } from "../../../src/content/network";
import { techniques } from "../../../src/content/techniques";
import { createWorld } from "../../../src/core/sim/world";
import { networkIndex, nodeOf, run } from "../../fixtures/attack";

const exec = promisify(execFile);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "build-attack.mjs");

const scratch = mkdtempSync(join(tmpdir(), "rail-breach-catalog-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------- fixture bundle

interface Stix {
  [key: string]: unknown;
}

/** The tactics the synthetic bundle gives each technique. Shapes mirror the real bundle. */
const PHASES: Record<string, string[]> = {
  T0865: ["initial-access"],
  T0822: ["initial-access"],
  T0859: ["persistence", "lateral-movement"],
  T0886: ["initial-access", "lateral-movement"],
  T0866: ["initial-access", "lateral-movement"],
  T0840: ["discovery"],
  "T1692.001": ["evasion", "impair-process-control"],
  T0836: ["impair-process-control"],
  "T1691.001": ["inhibit-response-function"],
  "T1692.002": ["evasion", "impair-process-control"],
  T0813: ["impact"],
  T0829: ["impact"],
  T0880: ["impact"],
  T0855: ["impair-process-control"],
  T0803: ["inhibit-response-function"],
  T0856: ["evasion", "impair-process-control"],
};

function pattern(id: string, name: string, extra: Stix = {}): Stix {
  return {
    type: "attack-pattern",
    id: `attack-pattern--${id}`,
    name,
    external_references: [{ source_name: "mitre-attack", external_id: id }],
    kill_chain_phases: (PHASES[id] ?? []).map((phase_name) => ({
      kill_chain_name: "mitre-ics-attack",
      phase_name,
    })),
    ...extra,
  };
}

/** A small bundle with every allow-listed technique, for exercising the trimming logic. */
function bundle(edit: (objects: Stix[]) => Stix[] = (o) => o): Stix {
  const objects: Stix[] = [
    {
      type: "x-mitre-collection",
      id: "x-mitre-collection--test",
      x_mitre_version: "19.2",
      modified: "2026-08-05T00:00:00.000Z",
    },
    pattern("T1691", "Block Operational Technology Message"),
    pattern("T1692", "Unauthorized Message"),
    pattern("T1691.001", "Command Message", { x_mitre_is_subtechnique: true }),
    pattern("T1692.001", "Command Message", { x_mitre_is_subtechnique: true }),
    pattern("T1692.002", "Reporting Message", { x_mitre_is_subtechnique: true }),
    pattern("T0855", "Unauthorized Command Message", { revoked: true }),
    pattern("T0803", "Block Command Message", { revoked: true }),
    pattern("T0856", "Spoof Reporting Message", { revoked: true }),
    {
      type: "relationship",
      relationship_type: "subtechnique-of",
      source_ref: "attack-pattern--T1691.001",
      target_ref: "attack-pattern--T1691",
    },
    {
      type: "relationship",
      relationship_type: "subtechnique-of",
      source_ref: "attack-pattern--T1692.001",
      target_ref: "attack-pattern--T1692",
    },
    {
      type: "relationship",
      relationship_type: "subtechnique-of",
      source_ref: "attack-pattern--T1692.002",
      target_ref: "attack-pattern--T1692",
    },
    {
      type: "relationship",
      relationship_type: "revoked-by",
      source_ref: "attack-pattern--T0855",
      target_ref: "attack-pattern--T1692.001",
    },
    {
      type: "relationship",
      relationship_type: "revoked-by",
      source_ref: "attack-pattern--T0803",
      target_ref: "attack-pattern--T1691.001",
    },
    {
      type: "relationship",
      relationship_type: "revoked-by",
      source_ref: "attack-pattern--T0856",
      target_ref: "attack-pattern--T1692.002",
    },
  ];
  const names: Record<string, string> = {
    T0865: "Spearphishing Attachment",
    T0822: "External Remote Services",
    T0859: "Valid Accounts",
    T0886: "Remote Services",
    T0866: "Exploitation of Remote Services",
    T0840: "Network Connection Enumeration",
    T0836: "Modify Parameter",
    T0813: "Denial of Control",
    T0829: "Loss of View",
    T0880: "Loss of Safety",
  };
  for (const [id, name] of Object.entries(names)) objects.push(pattern(id, name));
  return { type: "bundle", id: "bundle--test", objects: edit(objects) };
}

const META = { sha256: "f".repeat(64), url: "https://example.invalid/bundle.json" };
const idOf = (o: Stix): string | undefined =>
  (o.external_references as { external_id: string }[] | undefined)?.[0]?.external_id;

describe("the catalogue generator, on a synthetic bundle", () => {
  it("keeps the 13 techniques and the three revoked aliases, sorted by id", () => {
    const catalogue = buildCatalog(bundle(), META);
    const ids = catalogue.techniques.map((t) => t.id);
    expect(ids).toEqual([...CURRENT_IDS, ...LEGACY_IDS].sort());
    expect(catalogue.attackVersion).toBe(ATTACK_VERSION);
    expect(catalogue.source.sha256).toBe(META.sha256);
  });

  it("names a sub-technique after its parent and records the legacy ID it replaced", () => {
    const byId = new Map(buildCatalog(bundle(), META).techniques.map((t) => [t.id, t]));
    expect(byId.get("T1692.002")).toMatchObject({
      name: "Unauthorized Message: Reporting Message",
      legacyId: "T0856",
      revoked: false,
      tactics: ["evasion", "impair-process-control"],
    });
    expect(byId.get("T0856")).toMatchObject({ revoked: true, supersededBy: "T1692.002" });
    expect(byId.get("T0886")?.legacyId).toBeUndefined();
  });

  it("matches IDs exactly: a near-miss ID is not the technique", () => {
    const tampered = bundle((objects) =>
      objects.map((o) =>
        idOf(o) === "T0840"
          ? {
              ...o,
              external_references: [{ source_name: "mitre-attack", external_id: "T840" }],
            }
          : o,
      ),
    );
    expect(() => buildCatalog(tampered, META)).toThrow(/T0840 is not in the bundle/);
  });

  it("refuses a bundle in which an expected technique is missing, revoked or unaliased", () => {
    const without = (id: string) => bundle((objects) => objects.filter((o) => idOf(o) !== id));
    expect(() => buildCatalog(without("T0813"), META)).toThrow(/T0813 is not in the bundle/);
    expect(() => buildCatalog(without("T0855"), META)).toThrow(/T0855 is not in the bundle/);

    const revoked = bundle((objects) =>
      objects.map((o) => (idOf(o) === "T0813" ? { ...o, revoked: true } : o)),
    );
    expect(() => buildCatalog(revoked, META)).toThrow(/T0813 is revoked or deprecated/);

    const notRevoked = bundle((objects) =>
      objects.map((o) => (idOf(o) === "T0803" ? { ...o, revoked: false } : o)),
    );
    expect(() => buildCatalog(notRevoked, META)).toThrow(/T0803 is not revoked/);

    const unlinked = bundle((objects) =>
      objects.filter((o) => o.relationship_type !== "revoked-by"),
    );
    expect(() => buildCatalog(unlinked, META)).toThrow(/not revoked by an allow-listed technique/);
  });

  it("refuses a bundle of another ATT&CK version, an empty one and a non-bundle", () => {
    const other = bundle((objects) =>
      objects.map((o) => (o.type === "x-mitre-collection" ? { ...o, x_mitre_version: "18.0" } : o)),
    );
    expect(() => buildCatalog(other, META)).toThrow(/expected 19\.2/);
    expect(() => buildCatalog({ type: "bundle", objects: [] }, META)).toThrow(/not a STIX bundle/);
    expect(() => buildCatalog([], META)).toThrow(/not a STIX bundle/);
    expect(() => buildCatalog(null, META)).toThrow(/not a STIX bundle/);
  });

  it("lays JSON out the way the formatter does, so regeneration leaves no diff", () => {
    const text = serialise({ a: ["x", "y"], b: { c: 1 } });
    expect(text).toBe('{\n  "a": ["x", "y"],\n  "b": {\n    "c": 1\n  }\n}\n');
  });
});

describe("the committed catalogue", () => {
  const entries = attackCatalog.techniques;
  const byId = new Map(entries.map((t) => [t.id, t]));

  it("is ATT&CK for ICS v19.2 from the pinned source", () => {
    expect(attackCatalog.attackVersion).toBe("19.2");
    expect(attackCatalog.source.sha256).toBe(SOURCE_SHA256);
    expect(entries.every((t) => t.attackVersion === "19.2")).toBe(true);
  });

  it("lists the 13 phase techniques and the three legacy aliases, nothing else", () => {
    expect(entries.map((t) => t.id)).toEqual([...CURRENT_IDS, ...LEGACY_IDS].sort());
    for (const id of CURRENT_IDS) expect(byId.get(id)?.revoked, id).toBe(false);
    for (const id of LEGACY_IDS) expect(byId.get(id)?.revoked, id).toBe(true);
  });

  it("carries the new ID and the legacy ID of the three restructured techniques", () => {
    const pairs = [
      ["T1692.001", "T0855"],
      ["T1691.001", "T0803"],
      ["T1692.002", "T0856"],
    ] as const;
    for (const [current, legacy] of pairs) {
      expect(byId.get(current)).toMatchObject({ legacyId: legacy, revoked: false });
      expect(byId.get(legacy)).toMatchObject({ supersededBy: current, revoked: true });
    }
    expect(byId.get("T1692.002")?.name).toBe("Unauthorized Message: Reporting Message");
  });

  it("is a trimmed name-level listing: no descriptions, no operational text", () => {
    const text = readFileSync(join(ROOT, "src", "content", "attack-ics.json"), "utf8");
    expect(text).not.toMatch(/CVE-\d/i);
    expect(text).not.toMatch(/description|x_mitre_|external_references/);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.revoked
          ? [
              "attackVersion",
              "id",
              "name",
              "revoked",
              "source",
              "supersededBy",
              "tactic",
              "tactics",
            ]
          : [
              "attackVersion",
              "id",
              ...(entry.legacyId === undefined ? [] : ["legacyId"]),
              "name",
              "revoked",
              "source",
              "tactic",
              "tactics",
            ],
      );
    }
  });
});

// ---------------------------------------------------------------- fail-loud script

interface Outcome {
  code: number;
  out: string;
}

async function generate(...args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the generator script fails loud and writes nothing", () => {
  const out = join(scratch, "attack-out.json");

  const expectRefused = async (source: string, message: RegExp): Promise<void> => {
    writeFileSync(out, "previous catalogue\n");
    const result = await generate("--source", source, "--out", out);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(message);
    expect(readFileSync(out, "utf8")).toBe("previous catalogue\n");
    expect(existsSync(`${out}.tmp`)).toBe(false);
  };

  it("on an empty source", async () => {
    const empty = join(scratch, "empty.json");
    writeFileSync(empty, "");
    await expectRefused(empty, /the source is empty/);
  });

  it("on a source whose SHA-256 is not the pin", async () => {
    const wrong = join(scratch, "wrong.json");
    writeFileSync(wrong, JSON.stringify(bundle()));
    await expectRefused(wrong, /the pin is [0-9a-f]{64}/);
  });

  it("on a source file that does not exist", async () => {
    await expectRefused(join(scratch, "nowhere.json"), /does not exist/);
  });

  it("on an unknown argument", async () => {
    const result = await generate("--wat");
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/unknown argument/);
  });

  it("never touches the committed catalogue on a refusal", async () => {
    const before = readFileSync(join(ROOT, "src", "content", "attack-ics.json"), "utf8");
    const empty = join(scratch, "empty2.json");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(empty, "");
    await generate("--source", empty);
    expect(readFileSync(join(ROOT, "src", "content", "attack-ics.json"), "utf8")).toBe(before);
  });
});

describe("the vendored source is never committed", () => {
  it("git ignores vendor/ics-attack-19.2.json", async () => {
    const result = await exec("git", ["check-ignore", "vendor/ics-attack-19.2.json"], {
      cwd: ROOT,
    });
    expect(result.stdout.trim()).toBe("vendor/ics-attack-19.2.json");
  });
});

// ---------------------------------------------------------------- tracer slice

describe("T1692.002 Unauthorized Message: Reporting Message, end to end", () => {
  const index = networkIndex();
  const launch = (technique: string, target: string) => ({
    t: 1,
    a: { type: "technique.launch" as const, technique, target },
  });

  /** A world in which the intruder already holds the traffic management server. */
  function withFoothold(seed: number) {
    const world = createWorld(network, seed);
    nodeOf(world, "tms-server").integrity = 1;
    return world;
  }

  it("is registered under its current ID and under its legacy ID", () => {
    const def = techniques.find((t) => t.id === "T1692.002");
    expect(def?.legacyId).toBe("T0856");
    expect(index.techniques.get("T1692.002")).toBe(def);
    expect(index.techniques.get("T0856")).toBe(def);
  });

  it("spoofs the view of a dispatcher console, and only there", () => {
    let succeeded = 0;
    for (let seed = 0; seed < 12; seed++) {
      const result = run(withFoothold(seed), index, [launch("T1692.002", "dispatch-hmi-1")], 400);
      const applied = result.events.filter((e) => e.k === "effect.applied");
      const console1 = nodeOf(result.world, "dispatch-hmi-1");
      if (result.events.some((e) => e.k === "technique.succeeded")) {
        succeeded++;
        expect(applied).toMatchObject([
          { technique: "T1692.002", node: "dispatch-hmi-1", effect: "setView" },
        ]);
        expect(console1.view).toBe("spoofed");
      } else {
        expect(applied).toEqual([]);
        expect(console1.view).toBe("ok");
      }
      for (const node of result.world.nodes) {
        if (node.id !== "dispatch-hmi-1") expect(node.view, node.id).toBe("ok");
      }
    }
    expect(succeeded).toBeGreaterThan(0);
  });

  it("launches under the legacy ID and runs as the current technique", () => {
    const result = run(withFoothold(1), index, [launch("T0856", "dispatch-hmi-1")], 400);
    const started = result.events.find((e) => e.k === "op.started");
    expect(started).toMatchObject({ technique: "T1692.002", target: "dispatch-hmi-1" });
  });

  it("crosses the supervisory link as a packet carrying its technique ID", () => {
    const result = run(withFoothold(1), index, [launch("T1692.002", "dispatch-hmi-1")], 400);
    const packets = result.events.filter((e) => e.k === "packet");
    expect(packets).toMatchObject([
      { technique: "T1692.002", from: "tms-server", to: "dispatch-hmi-1" },
    ]);
  });

  it("is refused from a clean world, and says what is missing", () => {
    const result = run(createWorld(network, 1), index, [launch("T1692.002", "dispatch-hmi-1")], 50);
    expect(result.events.filter((e) => e.k === "technique.rejected")).toMatchObject([
      { technique: "T1692.002", reasons: [expect.stringMatching(/no permitted scada-proto path/)] },
    ]);
  });

  it("does not accept a target that does not report to the operators", () => {
    const result = run(withFoothold(1), index, [launch("T1692.002", "corp-mail")], 50);
    expect(result.events.filter((e) => e.k === "technique.rejected")).toMatchObject([
      { reasons: [expect.stringMatching(/not a valid target/)] },
    ]);
  });
});
