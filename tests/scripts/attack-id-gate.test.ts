/// <reference types="node" />
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import attackCatalog from "../../src/content/attack-ics.json";

/**
 * ATK-06: every ATT&CK technique ID the code refers to must exist in the generated
 * catalogue and must not be revoked, unless it is one of the known aliases of a
 * current ID. IDs move between ATT&CK versions; this keeps the project from
 * quietly showing one that attack.mitre.org no longer has.
 *
 * IDs are matched exactly, in dotted form (T1692.001) and short form (T0855).
 * There is deliberately no rule that guesses by prefix, such as "T08 is old and
 * T16 is new": the catalogue is the only authority.
 */

const ROOT = process.cwd();

/** A technique ID token: T plus four digits, optionally .NNN, bounded on both sides. */
const ID_TOKEN = /\bT\d{4}(?:\.\d{3})?\b/g;

interface Entry {
  id: string;
  revoked: boolean;
  legacyId?: string;
  supersededBy?: string;
}

interface Finding {
  file: string;
  id: string;
  why: string;
}

/** Files whose text the gate reads: the source tree minus the catalogue itself. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|json)$/.test(entry.name) && entry.name !== "attack-ics.json") {
      out.push(path);
    }
  }
  return out.sort();
}

/** Every ID token in `roots`, judged against the catalogue. Empty result means the gate is green. */
function checkIds(
  roots: readonly string[],
  catalogue: readonly Entry[],
  base: string = ROOT,
): Finding[] {
  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const findings: Finding[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const id of new Set(text.match(ID_TOKEN) ?? [])) {
        const entry = byId.get(id);
        const where = relative(base, file).replaceAll("\\", "/");
        if (entry === undefined) {
          findings.push({ file: where, id, why: "is not in the ATT&CK catalogue" });
        } else if (entry.revoked) {
          const successor =
            entry.supersededBy === undefined ? undefined : byId.get(entry.supersededBy);
          const isAlias =
            successor !== undefined && !successor.revoked && successor.legacyId === id;
          if (!isAlias) findings.push({ file: where, id, why: "is revoked and not a known alias" });
        }
      }
    }
  }
  return findings;
}

const describeFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.file}: ${f.id} ${f.why}`).join("\n");

const scratch = mkdtempSync(join(tmpdir(), "rail-breach-idgate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}

describe("ATK-06: technique IDs in the code exist and are not revoked", () => {
  it("holds for the committed source tree", () => {
    const findings = checkIds([join(ROOT, "src")], attackCatalog.techniques, ROOT);
    expect(describeFindings(findings)).toBe("");
  });

  it("actually reads technique IDs out of the tree (the scan is not vacuous)", () => {
    const seen = new Set<string>();
    for (const file of sourceFiles(join(ROOT, "src"))) {
      for (const id of readFileSync(file, "utf8").match(ID_TOKEN) ?? []) seen.add(id);
    }
    // The 13 definitions, their three legacy aliases and the recorded scenario all show up.
    for (const id of ["T0865", "T1692.002", "T0856", "T1691.001", "T0880"]) {
      expect(seen.has(id), id).toBe(true);
    }
  });

  it("covers the scenarios and recordings, not only the technique definitions", () => {
    const files = sourceFiles(join(ROOT, "src")).map((f) =>
      relative(ROOT, f).replaceAll("\\", "/"),
    );
    expect(files).toContain("src/content/scenarios/phishing-dispatcher.ts");
    expect(files).toContain("src/recordings/phishing-dispatcher.json");
    expect(files).toContain("src/content/techniques/index.ts");
    expect(files.some((f) => f.startsWith("src/core/"))).toBe(true);
  });

  it("rejects an ID the catalogue does not have, in a technique or in a scenario", () => {
    const dir = tree("unknown", {
      "technique.ts": 'export const id = "T9999";\n',
      "scenario.ts": 'launch(10, "T0000", "node");\n',
    });
    const found = checkIds([dir], attackCatalog.techniques, scratch);
    expect(found.map((f) => `${f.file} ${f.id}`).sort()).toEqual([
      "unknown/scenario.ts T0000",
      "unknown/technique.ts T9999",
    ]);
  });

  it("rejects a revoked ID that is not a known alias of its successor", () => {
    const catalogue: Entry[] = [
      { id: "T0100", revoked: true },
      { id: "T0101", revoked: true, supersededBy: "T0102" },
      { id: "T0102", revoked: false, legacyId: "T0199" },
    ];
    const dir = tree("revoked", {
      "a.ts": "// T0100\n",
      "b.ts": "// T0101\n",
    });
    expect(checkIds([dir], catalogue, scratch).map((f) => `${f.id} ${f.why}`)).toEqual([
      "T0100 is revoked and not a known alias",
      "T0101 is revoked and not a known alias",
    ]);
  });

  it("accepts the three legacy IDs as aliases of their current IDs", () => {
    const dir = tree("aliases", {
      "a.ts":
        'const old = ["T0855", "T0803", "T0856"]; const now = ["T1692.001", "T1691.001", "T1692.002"];\n',
    });
    expect(checkIds([dir], attackCatalog.techniques, scratch)).toEqual([]);
  });

  it("matches exactly: a parent technique or a malformed sub-ID is not a listed technique", () => {
    const dir = tree("exact", {
      "parent.ts": "// T1692\n",
      "short.ts": "// T1692.01\n",
      "long.ts": "// T1692.0011\n",
    });
    const found = checkIds([dir], attackCatalog.techniques, scratch);
    expect(found.map((f) => `${f.file} ${f.id}`).sort()).toEqual([
      "exact/long.ts T1692",
      "exact/parent.ts T1692",
      "exact/short.ts T1692",
    ]);
  });

  it("does not classify by prefix: a T08 ID that is current passes, a T16 ID that is unknown fails", () => {
    const catalogue: Entry[] = [
      { id: "T0865", revoked: false },
      { id: "T1600.001", revoked: true },
    ];
    const dir = tree("prefix", { "a.ts": "// T0865 T1600.001 T1601.001\n" });
    expect(checkIds([dir], catalogue, scratch).map((f) => `${f.id} ${f.why}`)).toEqual([
      "T1600.001 is revoked and not a known alias",
      "T1601.001 is not in the ATT&CK catalogue",
    ]);
  });

  it("ignores text that only looks like an ID: other identifiers and longer words", () => {
    const dir = tree("lookalike", {
      "a.ts": "// T-01-12 ST0865 T08650 T0865x version T1 RT0000\n",
    });
    expect(checkIds([dir], attackCatalog.techniques, scratch)).toEqual([]);
  });
});
