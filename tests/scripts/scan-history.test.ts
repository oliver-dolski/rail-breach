/// <reference types="node" />
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
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

// Made-up local layers: none of these phrases belongs to a real tool, employer or operator.
const DENY_FILE = "# local phrases\n\nAcme Helper Bot\nbot@example.test\nzorbtool\n";
const LITERAL_FILE = "# literals\nGlobex Rail\ncs:ACME\n";

function layers(dir: string, { deny = DENY_FILE, literals = LITERAL_FILE, allow = "" } = {}) {
  info(dir, "commit-msg-deny", deny);
  info(dir, "history-scan-deny", literals);
  info(dir, "history-scan-allow", allow);
}

const warningLines = (out: string) => out.split("\n").filter((line) => line.startsWith("WARNING"));

describe("scan-history: local layers", () => {
  it("fails a multi-word or address-shaped deny phrase in messages, blobs, binary blobs, paths and identities", async () => {
    const dir = fixture();
    layers(dir);
    const msg = commit(dir, { "a.txt": "alpha\n" }, "thanks to acme   HELPER bot for this");
    commit(dir, { "docs/b.txt": "made by Acme  Helper\nBot\n" }, "add b");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    commit(dir, { "img/c.png": Buffer.concat([png, Buffer.from("mail bot@example.test\0")]) }, "c");
    commit(dir, { "Acme Helper Bot/readme.txt": "x\n" }, "add folder");
    commit(dir, { "d.txt": "d\n" }, "add d", "Someone <someone@example.test>");
    commit(dir, { "e.txt": "e\n" }, "add e", "Acme Helper Bot <x@example.test>");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    const denied = /denied[- ]phrase/;
    expect(linesFor(result.out, "(message)").join("\n")).toMatch(denied);
    expect(linesFor(result.out, "(message)").join("\n")).toContain(short(msg));
    expect(linesFor(result.out, "docs/b.txt")[0] ?? "").toMatch(denied);
    expect(linesFor(result.out, "img/c.png")[0] ?? "").toMatch(denied);
    expect(linesFor(result.out, "Acme Helper Bot/readme.txt")[0] ?? "").toMatch(denied);
    expect(linesFor(result.out, "(author)")[0] ?? "").toMatch(denied);
    expect(linesFor(result.out, "(committer)")[0] ?? "").toMatch(denied);
    expect(result.out).not.toContain("d.txt");
    // The scan points at the line of the list, it does not repeat the phrase.
    expect(linesFor(result.out, "docs/b.txt")[0] ?? "").toContain("commit-msg-deny line 3");
    expect(linesFor(result.out, "img/c.png")[0] ?? "").not.toContain("bot@example.test");
  });

  it("fails a single-word deny phrase unless its token is declared for that very path", async () => {
    const dir = fixture();
    const allow = [
      "# declared tokens",
      "",
      `src/a.ts\tzorbtool-sdk\tfunctional`,
      `src/c.ts\tzorbtool-sdk`,
      `src/d.ts\tzorbtool-sdk\tfunctional`,
      "",
    ].join("\n");
    layers(dir, { allow });
    commit(
      dir,
      {
        "src/a.ts": 'import "zorbtool-sdk";\n',
        "src/b.ts": 'import "zorbtool-sdk";\n',
        "src/c.ts": 'import "zorbtool-extra";\n',
        "src/d.ts": 'import "zorbtool-sdk"; // and zorbtool-more\n',
        "src/e.ts": "plain ZorbTool word\n",
      },
      "add sources",
    );
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(result.out).not.toContain("src/a.ts");
    expect(linesFor(result.out, "src/b.ts")[0] ?? "").toContain("zorbtool-sdk");
    expect(linesFor(result.out, "src/c.ts")[0] ?? "").toContain("zorbtool-extra");
    expect(linesFor(result.out, "src/d.ts")[0] ?? "").toContain("zorbtool-more");
    expect(linesFor(result.out, "src/d.ts").join("\n")).not.toContain("zorbtool-sdk");
    expect(linesFor(result.out, "src/e.ts")[0] ?? "").toContain("ZorbTool");
  });

  it("passes when every occurrence is declared, and never excuses messages or paths", async () => {
    const dir = fixture();
    layers(dir, { allow: "src/a.ts\tzorbtool-sdk\tfunctional\n" });
    commit(dir, { "src/a.ts": 'import "zorbtool-sdk";\n' }, "add source");
    const clean = await scan(dir, "--require-local");
    expect(clean.code).toBe(0);
    commit(dir, { "src/z.txt": "z\n" }, "mention zorbtool in a message");
    commit(dir, { "zorbtool/readme.txt": "z\n" }, "add folder");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(linesFor(result.out, "(message)").length).toBe(1);
    expect(linesFor(result.out, "zorbtool/readme.txt").length).toBe(1);
  });

  it("applies the operator literals to messages, blobs, paths and identities", async () => {
    const dir = fixture();
    layers(dir);
    commit(dir, { "a.txt": "see Globex   rail\n" }, "add a");
    commit(dir, { "b.txt": "an ACME unit\n" }, "add b");
    commit(dir, { "c.txt": "an acme unit, ACMEX and ACMEs and lowercase acme\n" }, "add c");
    commit(dir, { "d.txt": "d\n" }, "visit GLOBEX RAIL");
    commit(dir, { "ACME/e.txt": "e\n" }, "add e");
    commit(dir, { "f.txt": "f\n" }, "add f", "ACME Ops <ops@example.test>");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    const literal = /operator-literal/;
    expect(linesFor(result.out, "a.txt")[0] ?? "").toMatch(literal);
    expect(linesFor(result.out, "b.txt")[0] ?? "").toMatch(literal);
    expect(result.out).not.toContain("c.txt");
    expect(linesFor(result.out, "(message)")[0] ?? "").toMatch(literal);
    expect(linesFor(result.out, "ACME/e.txt")[0] ?? "").toMatch(literal);
    expect(linesFor(result.out, "(author)")[0] ?? "").toMatch(literal);
    expect(linesFor(result.out, "a.txt")[0] ?? "").toContain("history-scan-deny line 2");
  });

  it("runs the shape rules alone and warns once per skipped layer when no local file exists", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    const result = await scan(dir);
    expect(result.code).toBe(0);
    const warnings = warningLines(result.out);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("commit-msg-deny");
    expect(warnings.join("\n")).toContain("history-scan-deny");
    const bad = commit(dir, { "b.txt": `x ${EM_DASH} y\n` }, "add b");
    const again = await scan(dir);
    expect(again.code).toBe(1);
    expect(again.out).toContain(short(bad));
  });

  it("treats a missing local file as a violation with --require-local, naming each one", async () => {
    const dir = fixture();
    commit(dir, { "a.txt": "alpha\n" }, "add alpha");
    const result = await scan(dir, "--require-local");
    expect(result.code).toBe(1);
    for (const name of ["commit-msg-deny", "history-scan-deny", "history-scan-allow"]) {
      expect(linesFor(result.out, `.git/info/${name}`)[0] ?? "", name).toContain(
        "missing-local-file",
      );
    }
    layers(dir);
    expect((await scan(dir, "--require-local")).code).toBe(0);
    info(dir, "history-scan-allow", "not a valid line\n");
    expect((await scan(dir)).code).toBe(2);
  });

  it("lists every occurrence of a single-word phrase with --inventory and exits 0", async () => {
    const dir = fixture();
    layers(dir, { allow: "src/a.ts\tzorbtool-sdk\tfunctional\n" });
    const first = commit(
      dir,
      { "src/a.ts": 'import "zorbtool-sdk"; // zorbtool-sdk\n', "src/b.ts": "zorbtool-sdk\n" },
      "add sources",
    );
    commit(dir, { "src/b.ts": `x ${EM_DASH} y zorbtool-sdk\n` }, "edit b");
    const result = await scan(dir, "--inventory");
    expect(result.code).toBe(0);
    const a = linesFor(result.out, "src/a.ts");
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("zorbtool-sdk");
    expect(a[0]).toContain("count=2");
    expect(a[0]).toContain(short(first));
    expect(a[0]).toContain("declared=yes");
    const b = linesFor(result.out, "src/b.ts");
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("count=2");
    expect(b[0]).toContain("declared=no");
    expect(result.out).not.toContain("long-dash");
  });

  it("keeps the sk-test- placeholder out of the key rule and nothing else", async () => {
    const dir = fixture();
    const placeholder = ["sk", "-", "test", "-", "0123456789abcdefghijklmnop"].join("");
    const other = ["sk", "-", "live", "-", "0123456789abcdefghijklmnop"].join("");
    commit(dir, { "ok.txt": `${placeholder}\n`, "bad.txt": `${other}\n` }, "add keys");
    const result = await scan(dir);
    expect(result.code).toBe(1);
    expect(linesFor(result.out, "bad.txt")[0] ?? "").toContain("key-shape");
    expect(result.out).not.toContain("ok.txt");
  });
});

describe("scan-history: tracked sources hold none of the private phrases", () => {
  const infoDir = join(ROOT, ".git", "info");
  const lists = ["commit-msg-deny", "history-scan-deny"].map((name) => join(infoDir, name));
  const present = lists.filter((file) => existsSync(file));

  it.skipIf(present.length === 0)("contain no line of this repository's local lists", () => {
    const quote = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The same matching the scan applies: plain lines loosely, cs: lines as exact whole words.
    const matchers = present
      .flatMap((file) => readFileSync(file, "utf8").split(/\r?\n/))
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) =>
        line.startsWith("cs:")
          ? new RegExp(`(?<![A-Za-z0-9])${quote(line.slice(3))}(?![A-Za-z0-9])`)
          : new RegExp(line.split(/\s+/).map(quote).join("\\s+"), "i"),
      );
    expect(matchers.length).toBeGreaterThan(0);
    for (const source of [
      "scripts/scan-history.mjs",
      "scripts/lib/hygiene.mjs",
      "scripts/check-commit-msg.mjs",
      "tests/scripts/scan-history.test.ts",
    ]) {
      const text = readFileSync(join(ROOT, source), "utf8");
      for (const [index, matcher] of matchers.entries()) {
        // Name the entry by position, never by content.
        expect(matcher.test(text), `${source} holds local list entry ${index + 1}`).toBe(false);
      }
    }
  });
});
