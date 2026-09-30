/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = process.cwd();
const CORE_LINT = join(ROOT, "scripts", "check-core-determinism.mjs");
const MSG_LINT = join(ROOT, "scripts", "check-commit-msg.mjs");

interface Outcome {
  code: number;
  out: string;
}

async function node(script: string, ...args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "rail-breach-gates-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function coreDir(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}

function message(name: string, body: string): string {
  const file = join(scratch, `${name}.txt`);
  writeFileSync(file, body);
  return file;
}

describe("lint:core determinism gate", () => {
  it("passes on the committed core", async () => {
    const result = await node(CORE_LINT, join(ROOT, "src", "core"));
    expect(result.out).toContain("files clean");
    expect(result.code).toBe(0);
  });

  it("rejects each banned API and names the file and line", async () => {
    const banned: Record<string, string> = {
      "random.ts": "export const x = Math.random();\n",
      "date.ts": "export const x = Date.now();\n",
      "newdate.ts": "export const x = new Date(0);\n",
      "perf.ts": "export const x = performance.now();\n",
      "sin.ts": "export const x = Math.sin(1);\n",
      "cos.ts": "export const x = Math.cos(1);\n",
      "tan.ts": "export const x = Math.tan(1);\n",
      "exp.ts": "export const x = Math.exp(1);\n",
      "pow.ts": "export const x = Math.pow(2, 3);\n",
      "log.ts": "export const x = Math.log(2);\n",
      "atan2.ts": "export const x = Math.atan2(1, 2);\n",
      "computed.ts": 'export const x = Math["random"]();\n',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture is TypeScript source text
      "template.ts": "export const x = `n=${Math.random()}`;\n",
      "nested/deep.ts": "export const x = Math.random();\n",
    };
    const dir = coreDir("banned", {});
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (const [file, body] of Object.entries(banned)) writeFileSync(join(dir, file), body);

    const result = await node(CORE_LINT, dir);
    expect(result.code).toBe(1);
    for (const file of Object.keys(banned)) {
      expect(result.out, `${file} should be reported`).toContain(`${file}:1:`);
    }
  });

  it("ignores banned names in comments and strings, and allows exact integer math", async () => {
    const dir = coreDir("clean", {
      "prose.ts": [
        "// Math.random and Date.now are banned here",
        "/* performance.now() and Math.sin(1)",
        "   across lines */",
        'export const note = "Math.random() is not allowed";',
        "export const url = 'http://example.test/Math.pow';",
        "export const ok = Math.imul(3, 5) + Math.floor(7 / 2) + Math.min(1, 2) + Math.sqrt(4);",
        "export const update = 1;",
        "",
      ].join("\n"),
    });
    const result = await node(CORE_LINT, dir);
    expect(result.out).toContain("files clean");
    expect(result.code).toBe(0);
  });

  it("refuses to pass vacuously on an empty directory", async () => {
    const result = await node(CORE_LINT, coreDir("empty", {}));
    expect(result.code).not.toBe(0);
  });
});

describe("commit-msg hygiene gate", () => {
  const emDash = String.fromCharCode(0x2014);
  const enDash = String.fromCharCode(0x2013);
  const tool = "Acme Tool";

  it("accepts a clean message, including comment lines and a verbose diff below the scissors", async () => {
    const clean = [
      "feat(01-01): add thing",
      "",
      "Explains why - with a plain hyphen.",
      "",
      "# Please enter the commit message",
      "# ------------------------ >8 ------------------------",
      `+ diff mentioning ${tool} and ${emDash}`,
      "",
    ].join("\n");
    expect((await node(MSG_LINT, message("clean", clean))).code).toBe(0);
  });

  it("rejects attribution trailers, banners and long dashes", async () => {
    const cases: Record<string, string> = {
      trailer: "feat: x\n\nCo-Authored-By: Someone <someone@example.test>\n",
      trailerLower: "feat: x\n\nco-authored-by: Someone <someone@example.test>\n",
      banner: "feat: x\n\nGenerated with a tool\n",
      emDash: `feat: x ${emDash} y\n`,
      enDash: `feat: x ${enDash} y\n`,
    };
    const results = await Promise.all(
      Object.entries(cases).map(async ([name, body]) => ({
        name,
        result: await node(MSG_LINT, message(name, body)),
      })),
    );
    for (const { name, result } of results) {
      expect(result.code, `${name} should be rejected`).toBe(1);
    }
  });

  it("rejects phrases from the deny list, matching case and whitespace loosely", async () => {
    const deny = message("deny", "# local phrases\n\nAcme Tool\nbot@example.test\n");
    const cases: Record<string, string> = {
      tool: `feat: x\n\nmade with ${tool}\n`,
      spacing: "feat: x\n\nmade with acme   TOOL\n",
      address: "feat: x\n\ncontact bot@example.test\n",
    };
    for (const [name, body] of Object.entries(cases)) {
      const result = await node(MSG_LINT, message(name, body), deny);
      expect(result.code, `${name} should be rejected`).toBe(1);
    }
    const allowed = message("allowed", "feat: x\n\nplain words\n");
    expect((await node(MSG_LINT, allowed, deny)).code).toBe(0);
  });

  it("treats a missing deny list as empty", async () => {
    const body = message("no-deny", `feat: x\n\nmade with ${tool}\n`);
    expect((await node(MSG_LINT, body, join(scratch, "absent-deny"))).code).toBe(0);
  });

  it("fails on a missing message file instead of passing", async () => {
    const result = await node(MSG_LINT, join(scratch, "does-not-exist.txt"));
    expect(result.code).not.toBe(0);
  });
});
