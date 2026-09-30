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

  it("rejects aliasing, destructuring and the other ways around a textual match", async () => {
    const aliased: Record<string, string> = {
      "alias.ts": "const M = Math;\nexport const x = M.random();\n",
      "destructure.ts": "export const { random } = Math;\n",
      "global.ts": "export const x = globalThis.Math.random();\n",
      "reflect.ts": 'export const x = Reflect.get(Math, "random");\n',
      "intl.ts": "export const x = new Intl.NumberFormat().format(1);\n",
      "locale.ts": "export const x = (1).toLocaleString();\n",
      "selfcrypto.ts": "const { crypto } = self;\n",
      "evaluated.ts": 'export const x = eval("1");\n',
      "hypot.ts": "export const x = Math.hypot(3, 4);\n",
    };
    const result = await node(CORE_LINT, coreDir("aliased", aliased));
    expect(result.code).toBe(1);
    for (const file of Object.keys(aliased)) {
      // alias.ts breaks the rule on its first line already
      expect(result.out, `${file} should be reported`).toMatch(new RegExp(`${file}:[12]:`));
    }
  });

  it("still sees a banned call after a regex literal that contains a quote", async () => {
    const quoted: Record<string, string> = {
      "double.ts": 'export const x = /"/.test(s) && Math.random();\n',
      "single.ts": "export const x = /'/.test(s) ? Math.random() : 0;\n",
      "klass.ts": "export const x = /[/'\"]+/.test(s) || Date.now();\n",
    };
    const result = await node(CORE_LINT, coreDir("regex-quote", quoted));
    expect(result.code).toBe(1);
    for (const file of Object.keys(quoted)) {
      expect(result.out, `${file} should be reported`).toContain(`${file}:1:`);
    }
  });

  it("tells division from a regex literal and blanks banned names inside a literal", async () => {
    const divided = coreDir("division", {
      "divide.ts": "export const x = (a + b) / 2; export const y = Math.random() / 2;\n",
    });
    expect((await node(CORE_LINT, divided)).out).toContain("divide.ts:1:");

    const clean = coreDir("regex-clean", {
      "ok.ts": [
        "export const a = /Math.random|Date/.test(s);",
        "export const b = i++ / 2 + n / 4;",
        "export const c = Math.round(x / 3) + Math.ceil(y / 3);",
        "",
      ].join("\n"),
    });
    const result = await node(CORE_LINT, clean);
    expect(result.out).toContain("files clean");
    expect(result.code).toBe(0);
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
