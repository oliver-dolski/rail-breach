/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Line based on purpose: the repo has no YAML dependency and the workflow is small and flat.
const text = readFileSync(join(process.cwd(), ".github", "workflows", "deploy.yml"), "utf8");
const lines = text.split("\n");

const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/configure-pages",
  "actions/upload-pages-artifact",
  "actions/deploy-pages",
];

/** The lines of a top-level block (`jobs:`) or of a job below it, by indent. */
function block(start: RegExp, indent: number): string[] {
  const from = lines.findIndex((line) => start.test(line));
  if (from === -1) throw new Error(`no block ${start}`);
  const inside: string[] = [];
  for (const line of lines.slice(from + 1)) {
    const own = line.length - line.trimStart().length;
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && own <= indent) break;
    inside.push(line);
  }
  return inside;
}

const buildJob = block(/^ {2}build:/, 2);
const deployJob = block(/^ {2}deploy:/, 2);
const joined = (part: string[]) => part.join("\n");

describe("deploy workflow", () => {
  it("pins every action to a full commit SHA with its release tag in a comment", () => {
    const uses = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(-\s*)?uses:/.test(line));
    expect(uses).toHaveLength(ACTIONS.length);
    const seen: string[] = [];
    for (const { line, index } of uses) {
      const match = /uses:\s*(actions\/[a-z-]+)@(\S+)\s*(#.*)?$/.exec(line);
      expect(match, line).not.toBeNull();
      const [, name = "", ref = "", comment = ""] = match ?? [];
      expect(ACTIONS, line).toContain(name);
      seen.push(name);
      if (/^[0-9a-f]{40}$/.test(ref)) {
        expect(comment, line).toMatch(/^# v\d+\.\d+\.\d+$/);
      } else {
        // Documented fallback: a major tag is accepted only when git ls-remote could not be
        // reached, and the line above must say so.
        expect(ref, line).toMatch(/^v\d+$/);
        expect(lines[index - 1] ?? "", line).toContain("could not be verified");
      }
    }
    expect([...seen].sort()).toEqual([...ACTIONS].sort());
  });

  it("keeps the workflow token at contents read at the top and in the build job", () => {
    expect(block(/^permissions:/, 0).filter((line) => line.trim() !== "")).toEqual([
      "  contents: read",
    ]);
    expect(joined(buildJob)).toMatch(/permissions:\n\s+contents: read\n/);
    expect(joined(buildJob)).not.toMatch(/(pages|id-token|contents): write/);
  });

  it("grants pages write and id-token write in the deploy job only, and nothing else there", () => {
    const deployPermissions = deployJob
      .slice(deployJob.findIndex((line) => /^ {4}permissions:/.test(line)) + 1)
      .filter((line) => /^ {6}\S/.test(line))
      .slice(0, 2)
      .map((line) => line.trim());
    expect(deployPermissions).toEqual(["pages: write", "id-token: write"]);
    for (const grant of ["pages: write", "id-token: write"]) {
      const everywhere = text.split(grant).length - 1;
      const inDeploy = joined(deployJob).split(grant).length - 1;
      expect(everywhere, grant).toBe(1);
      expect(inDeploy, grant).toBe(1);
    }
  });

  it("runs every gate in the build job, in order, test after build", () => {
    const runs = buildJob
      .map((line) => /^\s+run:\s*(.+)$/.exec(line)?.[1])
      .filter((run): run is string => run !== undefined);
    expect(runs).toEqual([
      "npm ci",
      "npm run scan:history",
      "npm run typecheck",
      "npm run typecheck:core",
      "npm run lint",
      "npm run lint:core",
      "npm run build",
      "npm test",
    ]);
  });

  it("scans the full history right after the install, on a full checkout", () => {
    const checkout = lines.findIndex((line) => line.includes("actions/checkout@"));
    expect(lines.slice(checkout + 1, checkout + 5).join("\n")).toContain("fetch-depth: 0");
    expect(text.split("fetch-depth: 0").length - 1).toBe(1);
    expect(text.split("scan:history").length - 1).toBe(1);
    const scan = lines.findIndex((line) => /^\s+run:\s*npm run scan:history\s*$/.test(line));
    expect(scan).toBeGreaterThan(-1);
    expect(lines.slice(scan - 2, scan).join("\n")).toContain("name: Scan the git history");
    const install = lines.findIndex((line) => /^\s+run:\s*npm ci\s*$/.test(line));
    expect(scan).toBeGreaterThan(install);
    expect(joined(deployJob)).not.toContain("scan:history");
  });

  it("triggers on push to main, pull requests and manual runs", () => {
    const triggers = block(/^on:/, 0);
    expect(joined(triggers)).toMatch(/push:\n\s+branches: \[main\]/);
    expect(triggers.some((line) => /^ {2}pull_request:\s*$/.test(line))).toBe(true);
    expect(triggers.some((line) => /^ {2}workflow_dispatch:\s*$/.test(line))).toBe(true);
  });

  it("uploads dist and nothing else, and not on pull requests", () => {
    const paths = lines.filter((line) => /^\s+path:/.test(line));
    expect(paths.map((line) => line.trim())).toEqual(["path: dist"]);
    const upload = lines.findIndex((line) => line.includes("actions/upload-pages-artifact@"));
    expect(lines[upload - 1]).toContain("github.event_name != 'pull_request'");
    expect(lines.slice(upload + 1, upload + 3).join("\n")).toContain("path: dist");
  });

  it("deploys only from main, never for a pull request", () => {
    const condition = deployJob.find((line) => /^ {4}if:/.test(line)) ?? "";
    expect(condition).toContain("refs/heads/main");
    expect(condition).toContain("!= 'pull_request'");
    expect(joined(deployJob)).toMatch(/needs: build/);
  });

  it("serialises Pages deployments without cancelling a started one", () => {
    expect(joined(deployJob)).toMatch(
      /concurrency:\n\s+group: pages\n\s+cancel-in-progress: false/,
    );
    expect(joined(buildJob)).not.toContain("concurrency");
  });

  it("checks out without persisting credentials and only in the build job", () => {
    const checkout = lines.findIndex((line) => line.includes("actions/checkout@"));
    expect(lines.slice(checkout + 1, checkout + 4).join("\n")).toContain(
      "persist-credentials: false",
    );
    expect(joined(deployJob)).not.toContain("actions/checkout");
  });

  it("uses no secret, no pull_request_target and no long dash", () => {
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toContain(EN_DASH);
    expect(text).not.toContain(EM_DASH);
  });
});
