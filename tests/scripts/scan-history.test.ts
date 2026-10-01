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

/** The violation lines of the output that name a path (or "(message)"). */
function linesFor(out: string, where: string): string[] {
  return out.split("\n").filter((line) => line.includes(` | ${where} | `));
}

const words = (...parts: string[]) => parts.join(" ");
const dots = (...parts: string[]) => parts.join(".");

describe("scan-history: shape rules", () => {
  it("fails key-shaped strings in old revisions and prints them masked", async () => {
    const dir = fixture();
    const provider = ["sk", "-", "Ab12".repeat(8)].join("");
    const github = ["ghp", "_", "a1B2c3".repeat(7)].join("");
    const aws = ["AKIA", "ABCDEFGHIJ123456"].join("");
    const pem = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
    commit(
      dir,
      {
        "k/provider.txt": `key = ${provider}\n`,
        "k/github.txt": `token: ${github}\n`,
        "k/aws.txt": `id=${aws}\n`,
        "k/pem.txt": `${pem}\nMIIE\n`,
        "k/fine.txt": "a sk-short and risk-assessment-and-analysis-notes-here and ghp_short\n",
      },
      "add keys",
    );
    commit(
      dir,
      { "k/provider.txt": null, "k/github.txt": null, "k/aws.txt": null, "k/pem.txt": null },
      "remove them again",
    );
    const result = await scan(dir);
    expect(result.code).toBe(1);
    for (const [path, secret] of [
      ["k/provider.txt", provider],
      ["k/github.txt", github],
      ["k/aws.txt", aws],
      ["k/pem.txt", pem],
    ] as const) {
      const [line = ""] = linesFor(result.out, path);
      expect(line, path).toContain("key-shape");
      expect(line, path).toContain(`${secret.slice(0, 6)}...`);
      expect(result.out, path).not.toContain(secret);
      expect(result.out, path).not.toContain(secret.slice(0, 12));
    }
    expect(result.out).not.toContain("k/fine.txt");
  });

  it("separates private from other non-documentation IPv4 addresses and passes the rest", async () => {
    const dir = fixture();
    const bad: Record<string, string> = {
      "ip/a10.txt": dots("10", "1", "2", "3"),
      "ip/a172lo.txt": dots("172", "16", "5", "5"),
      "ip/a172hi.txt": dots("172", "31", "0", "1"),
      "ip/a192.txt": dots("192", "168", "1", "10"),
      "ip/a169.txt": dots("169", "254", "1", "1"),
      "ip/a100lo.txt": dots("100", "64", "0", "1"),
      "ip/a100hi.txt": dots("100", "127", "255", "1"),
      "ip/pub8.txt": dots("8", "8", "8", "8"),
      "ip/pub172.txt": dots("172", "32", "0", "1"),
      "ip/pub100.txt": dots("100", "128", "0", "1"),
    };
    const good: Record<string, string> = {
      "ok/doc1.txt": dots("192", "0", "2", "7"),
      "ok/doc2.txt": dots("198", "51", "100", "7"),
      "ok/doc3.txt": dots("203", "0", "113", "7"),
      "ok/loop.txt": dots("127", "0", "0", "1"),
      "ok/zero.txt": dots("0", "0", "0", "0"),
      "ok/range.txt": dots("1", "2", "3", "456"),
      "ok/three.txt": dots("1", "2", "3"),
      "ok/five.txt": dots("1", "2", "3", "4", "5"),
      "ok/version.txt": `v${dots("1", "2", "3", "4")} and build${dots("5", "6", "7", "8")}`,
      "ok/big.txt": dots("300", "1", "1", "1"),
    };
    const files: Files = {};
    for (const [path, address] of Object.entries({ ...bad, ...good })) {
      files[path] = `host ${address} end\n`;
    }
    commit(dir, files, "add addresses");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    for (const path of Object.keys(bad)) {
      const [line = ""] = linesFor(result.out, path);
      const rule = /pub/.test(path) ? "public-ipv4" : "private-ipv4";
      expect(line, path).toContain(rule);
    }
    for (const path of Object.keys(good)) expect(result.out, path).not.toContain(path);
  });

  it("fails local user paths and passes placeholders", async () => {
    const dir = fixture();
    const bs = String.fromCharCode(0x5c);
    const bad: Record<string, string> = {
      "p/win.txt": ["C:", "Users", "jdoe", "src"].join(bs),
      "p/winslash.txt": `C:/${["Users", "jdoe", "src"].join("/")}`,
      "p/escaped.txt": ["C:", "Users", "jdoe"].join(bs + bs),
      "p/gitbash.txt": `/c/${["Users", "jdoe", "src"].join("/")}`,
      "p/linux.txt": `/${["home", "jdoe", "src"].join("/")}`,
      "p/mac.txt": `/${["Users", "jdoe", "src"].join("/")}`,
      "p/appdata.txt": ["x", ["App", "Data"].join(""), "Local"].join(bs),
    };
    const good: Record<string, string> = {
      "q/placeholder.txt": ["C:", "Users", "<name>", "src"].join(bs),
      "q/relative.txt": "see src/home/readme and the Users panel",
    };
    const files: Files = {};
    for (const [path, text] of Object.entries({ ...bad, ...good })) files[path] = `at ${text}\n`;
    commit(dir, files, "add paths");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    for (const path of Object.keys(bad)) {
      expect(linesFor(result.out, path)[0] ?? "", path).toContain("local-user-path");
    }
    for (const path of Object.keys(good)) expect(result.out, path).not.toContain(path);
  });

  it("fails AI-attribution phrasing and passes ordinary uses of the words", async () => {
    const dir = fixture();
    const trailer = ["Co-Authored-By", ": Helper <helper@example.test>"].join("");
    const bad: Record<string, string> = {
      "a/gen.txt": words("Generated", "with", "an", "AI"),
      "a/written.txt": words("written", "by", "a", "language", "model"),
      "a/created.txt": words("Created", "using", "an", "LLM"),
      "a/assisted.txt": words("assisted", "by", "a", "chatbot"),
      "a/authored.txt": words("authored", "with", "an", "assistant"),
      "a/drafted.txt": words("drafted", "by", "the", "assistant"),
      "a/hyphen.txt": ["AI", "generated"].join("-"),
      "a/hyphen2.txt": ["AI", "assisted"].join("-"),
      "a/trailer.txt": `Notes\n${trailer}\n`,
    };
    const good: Record<string, string> = {
      "b/script.txt": "generated by scripts/build-attack.mjs",
      "b/tool.txt": "Generated with a tool",
      "b/hand.txt": "written by hand, produced using a lathe",
      "b/panel.txt": "the assistant panel and the AI layer",
      "b/inline.txt": `"${trailer}" in a string, mid-line`,
    };
    const files: Files = {};
    for (const [path, text] of Object.entries({ ...bad, ...good })) {
      files[path] = text.includes("\n") ? text : `${text}\n`;
    }
    commit(dir, files, "add phrases");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    for (const path of Object.keys(bad)) {
      const [line = ""] = linesFor(result.out, path);
      expect(line, path).toMatch(/ai-attribution|co-author trailer/);
    }
    for (const path of Object.keys(good)) expect(result.out, path).not.toContain(path);
  });

  it("applies the shape rules to commit messages as well", async () => {
    const dir = fixture();
    const provider = ["sk", "-", "Zy98".repeat(8)].join("");
    const message = [
      "add things",
      "",
      `key ${provider}`,
      `host ${dots("10", "9", "8", "7")}`,
      words("written", "by", "an", "LLM"),
      ["C:", "Users", "jdoe"].join(String.fromCharCode(0x5c)),
    ].join("\n");
    const bad = commit(dir, { "a.txt": "alpha\n" }, message);
    const result = await scan(dir);
    expect(result.code).toBe(1);
    const lines = linesFor(result.out, "(message)").join("\n");
    for (const rule of ["key-shape", "private-ipv4", "ai-attribution", "local-user-path"]) {
      expect(lines, rule).toContain(rule);
    }
    expect(lines).toContain(short(bad));
    expect(result.out).not.toContain(provider);
  });
});

describe("scan-history: binary blobs, size and identities", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("scans binary blobs as bytes, so text hidden in metadata is found", async () => {
    const dir = fixture();
    const provider = ["sk", "-", "Qw34".repeat(8)].join("");
    const meta = (text: string) => Buffer.concat([png, Buffer.from(`tEXt\0Comment\0${text}\0`)]);
    commit(
      dir,
      {
        "img/key.png": meta(`k=${provider}`),
        "img/ip.png": meta(`h=${dots("10", "4", "4", "4")}`),
        "img/who.png": meta(words("written", "by", "an", "LLM")),
        "img/home.png": meta(`/${["home", "jdoe", "x"].join("/")}/`),
        "img/clean.png": meta("nothing here"),
      },
      "add images",
    );
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(linesFor(result.out, "img/key.png")[0] ?? "").toContain("key-shape");
    expect(linesFor(result.out, "img/ip.png")[0] ?? "").toContain("private-ipv4");
    expect(linesFor(result.out, "img/who.png")[0] ?? "").toContain("ai-attribution");
    expect(linesFor(result.out, "img/home.png")[0] ?? "").toContain("local-user-path");
    expect(result.out).not.toContain("img/clean.png");
    expect(result.out).not.toContain(provider);
  });

  it("applies the long-dash rule to text blobs only", async () => {
    const dir = fixture();
    commit(
      dir,
      { "img/dash.png": Buffer.concat([png, Buffer.from(`x${EM_DASH}y`, "utf8")]) },
      "add binary with dash bytes",
    );
    const result = await scan(dir);
    expect(result.out).not.toContain("long-dash");
    expect(result.code).toBe(0);
  });

  it("fails a blob over 5 MiB with its size and passes one of exactly 5 MiB", async () => {
    const dir = fixture();
    const limit = 5 * 1024 * 1024;
    commit(
      dir,
      {
        "big/over.bin": Buffer.alloc(limit + 1, 0x61),
        "big/exact.bin": Buffer.alloc(limit, 0x62),
      },
      "add big files",
    );
    const result = await scan(dir);
    expect(result.code).toBe(1);
    const [line = ""] = linesFor(result.out, "big/over.bin");
    expect(line).toContain("oversize-blob");
    expect(line).toContain(String(limit + 1));
    expect(result.out).not.toContain("big/exact.bin");
  });

  it("reports the total size of image and video blobs in the summary", async () => {
    const dir = fixture();
    commit(
      dir,
      {
        "m/a.png": Buffer.alloc(100, 1),
        "m/b.mp4": Buffer.alloc(200, 2),
        "m/c.webm": Buffer.alloc(300, 3),
        "m/d.gif": Buffer.alloc(400, 4),
        "m/e.jpg": Buffer.alloc(500, 5),
        "m/same.png": Buffer.alloc(100, 1),
        "m/notes.txt": "x".repeat(1000),
      },
      "add media",
    );
    const result = await scan(dir);
    expect(result.out).toMatch(/media-bytes=1500\b/);
  });

  it("lists each distinct identity once in the summary", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "a\n" }, "one", "Ann Example <ann@example.test>");
    commit(dir, { "b.txt": "b\n" }, "two", "Ann Example <ann@example.test>");
    commit(dir, { "c.txt": "c\n" }, "three", "Bob Example <bob@example.test>");
    const result = await scan(dir);
    expect(result.out).toContain("identities=2");
    for (const who of ["Ann Example <ann@example.test>", "Bob Example <bob@example.test>"]) {
      expect(result.out.split(`identity: ${who}`).length - 1).toBe(1);
    }
  });
});
