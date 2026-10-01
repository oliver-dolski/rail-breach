/// <reference types="node" />
import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const run = promisify(execFile);
const ROOT = process.cwd();
const SCAN = join(ROOT, "scripts", "scan-history.mjs");

// Every hostile string is built at runtime: the scan reads this very file in history, so a
// literal here would be a finding.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const scratch = mkdtempSync(join(tmpdir(), "rail-breach-scan-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Fixture repositories must not run anyone's hooks or read anyone's configuration.
const hooksDir = join(scratch, "no-hooks");
mkdirSync(hooksDir);
const globalConfig = join(scratch, "gitconfig");
writeFileSync(globalConfig, "");
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const AUTHOR = "Test Author <author@example.test>";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

let counter = 0;
function fixture(): string {
  const dir = join(scratch, `repo-${counter++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

type Files = Record<string, string | Uint8Array | null>;

/** Writes (or, for null, removes) the files, stages everything and commits. Returns the hash. */
function commit(dir: string, files: Files, message: string, who: string = AUTHOR): string {
  for (const [file, body] of Object.entries(files)) {
    const target = join(dir, file);
    if (body === null) {
      rmSync(target, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
  git(dir, "add", "-f", "-A");
  const match = /^(.*) <(.*)>$/.exec(who);
  const name = match?.[1] ?? who;
  const email = match?.[2] ?? "";
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      `core.hooksPath=${hooksDir}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--no-verify",
      "--allow-empty",
      "-m",
      message,
    ],
    {
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    },
  );
  return git(dir, "rev-parse", "HEAD");
}

/** Writes an untracked file under .git/info of the fixture. */
function info(dir: string, name: string, body: string): void {
  const folder = join(dir, ".git", "info");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), body);
}

interface Outcome {
  code: number;
  out: string;
}

async function scan(dir: string, ...args: string[]): Promise<Outcome> {
  return scanIn(undefined, ["--repo", dir, ...args]);
}

async function scanIn(cwd: string | undefined, args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCAN, ...args], {
      env: GIT_ENV,
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const short = (hash: string) => hash.slice(0, 7);

/** Every file under a directory with its size and mtime, .git included. */
function snapshot(dir: string): string[] {
  const rows: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        const stat = statSync(path);
        rows.push(`${path} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return rows.sort();
}

describe("scan-history: messages, blobs and paths end to end", () => {
  it("passes a clean fixture and prints the counts", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    commit(dir, { "b.txt": "beta\n" }, "add beta");
    const result = await scan(dir);
    expect(result.out).toMatch(/scan-history: commits=2 blobs=2 paths=2 identities=1 violations=0/);
    expect(result.code).toBe(0);
  });

  it("finds a long dash that a later commit deleted, naming rule, path and commit", async () => {
    const dir = fixture();
    commit(dir, { "notes/a.txt": "clean\n" }, "add a");
    const bad = commit(dir, { "notes/a.txt": `bad ${EM_DASH} text\n` }, "edit a");
    const gone = commit(dir, { "notes/a.txt": null }, "remove a");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("long-dash");
    expect(result.out).toContain("notes/a.txt");
    expect(result.out).toContain(short(bad));
    expect(result.out).not.toContain(short(gone));
    expect(result.out).not.toContain(EM_DASH);
  });

  it("finds an en dash too", async () => {
    const dir = fixture();
    const bad = commit(dir, { "b.txt": `1${EN_DASH}2\n` }, "add b");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("long-dash");
    expect(result.out).toContain(short(bad));
    expect(result.out).not.toContain(EN_DASH);
  });

  it("rejects a co-author trailer in an old message with the hook's rule name", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    const trailer = ["Co-Authored-By", ": Helper <helper@example.test>"].join("");
    const bad = commit(dir, { "b.txt": "beta\n" }, `add beta\n\n${trailer}`);
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("co-author trailer");
    expect(result.out).toContain(short(bad));
  });

  it("judges every line of a stored message, comment lines included", async () => {
    const dir = fixture();
    const banner = ["# Generated", "with a tool"].join(" ");
    const bad = commit(dir, { "a.txt": "alpha\n" }, `add alpha\n\n${banner}`);
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("generated-with banner");
    expect(result.out).toContain(short(bad));
  });

  it("finds a path an ignore rule covers even after the file was removed", async () => {
    const dir = fixture();
    info(dir, "exclude", "private-notes/\n");
    const added = commit(dir, { "private-notes/plan.txt": "x\n", "a.txt": "a\n" }, "oops");
    commit(dir, { "private-notes/plan.txt": null }, "remove it again");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("ignored-path");
    expect(result.out).toContain("private-notes/plan.txt");
    expect(result.out).toContain("private-notes/");
    expect(result.out).toContain(short(added));
  });

  it("counts the tracked .gitignore rules too, and only those of the repository", async () => {
    const dir = fixture();
    commit(dir, { ".gitignore": "*.local\n", "ok.txt": "ok\n" }, "add ignore rules");
    const bad = commit(dir, { "settings.local": "x\n" }, "add settings");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("ignored-path");
    expect(result.out).toContain("settings.local");
    expect(result.out).toContain(".gitignore");
    expect(result.out).toContain(short(bad));
    expect(result.out).not.toContain("ok.txt");
  });

  it("is read-only and prints the same thing twice", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n", "sub/c.txt": "c\n" }, "add");
    commit(dir, { "a.txt": `x ${EM_DASH} y\n` }, "edit");
    const before = {
      files: snapshot(dir),
      refs: git(dir, "for-each-ref"),
      objects: git(dir, "count-objects", "-v"),
      index: readFileSync(join(dir, ".git", "index")).toString("hex"),
    };
    const first = await scan(dir);
    const second = await scan(dir);
    expect(first.code).toBe(1);
    expect(second.out).toBe(first.out);
    expect({
      files: snapshot(dir),
      refs: git(dir, "for-each-ref"),
      objects: git(dir, "count-objects", "-v"),
      index: readFileSync(join(dir, ".git", "index")).toString("hex"),
    }).toEqual(before);
  });

  it("scans every ref, not only the checked out branch", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    git(dir, "checkout", "-q", "-b", "side");
    const bad = commit(dir, { "s.txt": `s ${EM_DASH} s\n` }, "side work");
    git(dir, "checkout", "-q", "main");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain(short(bad));
  });

  it("uses the repository of the working directory when --repo is absent", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    const result = await scanIn(dir, []);
    expect(result.out).toContain("commits=1");
    expect(result.code).toBe(0);
  });

  it("exits 2 on a usage error or a directory that is not a repository", async () => {
    const empty = mkdtempSync(join(scratch, "plain-"));
    expect((await scan(empty)).code).toBe(2);
    expect((await scanIn(empty, ["--bogus"])).code).toBe(2);
    expect((await scanIn(empty, ["--repo"])).code).toBe(2);
  });
});
