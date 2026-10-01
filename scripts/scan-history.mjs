#!/usr/bin/env node
// Full-history hygiene scan: `node scripts/scan-history.mjs [--require-local] [--inventory] [--repo <dir>]`.
//
// History becomes public for good at the first push, so this reads everything that would leave the
// machine: every commit reachable from any ref (message, author, committer), every blob of every
// revision with the path it had, and every path ever tracked, including files deleted again later.
// Messages go through the same rules the commit-msg hook applies (lib/hygiene.mjs).
//
// Output is one line per violation, `rule | commit | path | excerpt`, then a summary line. Exit 0
// when clean, 1 on any violation, 2 on a git or argument error. The scan only reads: it writes
// nothing into the repository or .git, never rewrites history, and prints the same text on every
// run over the same refs. The one file it creates is an empty excludes file in the system temp
// directory, removed before it exits.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkMessage, MESSAGE_RULES } from "./lib/hygiene.mjs";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const LONG_DASH = new RegExp(`[${EN_DASH}${EM_DASH}]`, "g");

const FIELD = "\x1f";
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MEDIA = /\.(?:png|gif|jpe?g|mp4|webm)$/i;

// Shape rules. Each pattern is written so that this file's own text does not match it: a character
// class or a group follows every prefix, never the bare literal. Run the scan on the repository
// after changing one.
const KEY_PATTERNS = [
  // sk-test- is the placeholder the key-handling tests use; no provider issues keys that start so.
  /(?<![A-Za-z0-9])sk-(?!test-)[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
];

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(
  `(?<![\\w.])(${OCTET})\\.(${OCTET})\\.(${OCTET})\\.(${OCTET})(?!\\w|\\.\\d)`,
  "g",
);

const USER_PATHS = [
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|*?]+/g,
  /(?<![\w.-])\/[a-z]\/Users\/[^/\s"']+/g,
  /(?<![\w.-])\/home\/[A-Za-z0-9._-]+\//g,
  /(?<![\w.-])\/Users\/[A-Za-z0-9._ -]+\//g,
  /AppData[\\/]/g,
];

const AI_NOUN = "(?:AI|LLMs?|language\\s+models?|chatbots?|assistants?)";
const ATTRIBUTION = [
  new RegExp(
    `\\b(?:generated|written|created|authored|produced|assisted|drafted)\\s+(?:with|by|using)\\s+(?:an?\\s+|the\\s+)?${AI_NOUN}\\b`,
    "gi",
  ),
  /\bAI[- ](?:generated|assisted)\b/gi,
];

/** A co-author trailer with an address, at the start of a line, as a blob can carry one. */
const TRAILER_LINE = /^[ \t]*co-authored-by[ \t]*:[^\n]*<[^<>\s]+@[^<>\s]+>/im;

/** Blobs are read in groups of at most this many bytes, so memory stays bounded. */
const BATCH_BYTES = 64 * 1024 * 1024;

class ScanError extends Error {}

function usage() {
  return "usage: scan-history.mjs [--require-local] [--inventory] [--repo <dir>]";
}

function parseArgs(argv) {
  const options = { requireLocal: false, inventory: false, repo: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-local") options.requireLocal = true;
    else if (arg === "--inventory") options.inventory = true;
    else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ScanError(usage());
      options.repo = value;
      i += 1;
    } else throw new ScanError(usage());
  }
  return options;
}

/** Runs git read-only and returns stdout as a Buffer. `ok` lists the exit codes that are not errors. */
function git(repo, args, { input, ok = [0] } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw new ScanError(`git ${args[0]}: ${result.error.message}`);
  if (!ok.includes(result.status ?? -1)) {
    const reason = result.stderr.toString("utf8").trim() || `exit ${result.status}`;
    throw new ScanError(`git ${args.join(" ")}: ${reason}`);
  }
  return result.stdout;
}

const gitText = (repo, args) => git(repo, args).toString("utf8").trim();

function resolveRepo(dir) {
  const from = resolve(dir ?? process.cwd());
  try {
    return gitText(from, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new ScanError(`${from} is not inside a git repository`);
  }
}

/** Commits oldest first, with the tree each one points at. */
function readCommits(repo) {
  const format = ["%H", "%T", "%an", "%ae", "%cn", "%ce", "%B"].join("%x1f");
  const raw = git(repo, [
    "log",
    "--all",
    "--topo-order",
    "--reverse",
    "-z",
    `--format=${format}`,
  ]).toString("utf8");
  return raw
    .split("\0")
    .filter((record) => record !== "")
    .map((record, index) => {
      const [hash = "", tree = "", an = "", ae = "", cn = "", ce = "", ...rest] =
        record.split(FIELD);
      return {
        index,
        hash,
        tree,
        author: `${an} <${ae}>`,
        committer: `${cn} <${ce}>`,
        message: rest.join(FIELD),
      };
    });
}

/**
 * Every (blob, path) pair of every revision, each attributed to the first commit it appears in.
 * A tree seen before cannot add a pair, so it is skipped.
 */
function readPairs(repo, commits) {
  const pairs = new Map();
  const seenTrees = new Set();
  for (const commit of commits) {
    if (seenTrees.has(commit.tree)) continue;
    seenTrees.add(commit.tree);
    const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit.hash]).toString("utf8");
    for (const entry of listing.split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const [, type = "", sha = ""] = entry.slice(0, tab).split(" ");
      if (type !== "blob") continue;
      const path = entry.slice(tab + 1);
      const key = `${sha}\0${path}`;
      if (!pairs.has(key)) pairs.set(key, { sha, path, commit });
    }
  }
  return [...pairs.values()];
}

/** Calls `visit(sha, bytes)` once per blob, reading in bounded groups. */
function readBlobs(repo, shas, visit) {
  const sizes = new Map();
  const checked = git(repo, ["cat-file", "--batch-check"], { input: `${shas.join("\n")}\n` })
    .toString("utf8")
    .split("\n");
  for (const line of checked) {
    const [sha, type, size] = line.split(" ");
    if (sha && type === "blob") sizes.set(sha, Number(size));
  }
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const sha of shas) {
    const size = sizes.get(sha);
    if (size === undefined) throw new ScanError(`blob ${sha} is missing from the object store`);
    if (group.length > 0 && bytes + size > BATCH_BYTES) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(sha);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  for (const members of groups) {
    const out = git(repo, ["cat-file", "--batch"], { input: `${members.join("\n")}\n` });
    let pos = 0;
    for (const sha of members) {
      const end = out.indexOf(0x0a, pos);
      const [, , size] = out.subarray(pos, end).toString("utf8").split(" ");
      const start = end + 1;
      const length = Number(size);
      visit(sha, out.subarray(start, start + length));
      pos = start + length + 1;
    }
  }
  return sizes;
}

/** A blob is text when its first 8000 bytes hold no NUL and the whole of it decodes as UTF-8. */
function decode(buf) {
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, text: buf.toString("latin1") };
  try {
    return { binary: false, text: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
  } catch {
    return { binary: true, text: buf.toString("latin1") };
  }
}

const isControl = (code) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Replaces long dashes and control characters so an excerpt is plain, one line and printable. */
function tidy(excerpt) {
  return excerpt
    .replace(new RegExp(EM_DASH, "g"), "[U+2014]")
    .replace(new RegExp(EN_DASH, "g"), "[U+2013]")
    .split("")
    .map((ch) => (isControl(ch.charCodeAt(0)) ? " " : ch))
    .join("")
    .replace(/ +/g, " ")
    .trim();
}

function around(text, index, length, radius = 14) {
  return tidy(text.slice(Math.max(0, index - radius), index + length + radius));
}

/** `private-ipv4`, `public-ipv4`, or null for the documentation, loopback and unspecified ranges. */
function classifyAddress(a, b, c, d) {
  if (a === 127 || (a === 0 && b === 0 && c === 0 && d === 0)) return null;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)) return null;
  if (a === 203 && b === 0 && c === 113) return null;
  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
  return isPrivate ? "private-ipv4" : "public-ipv4";
}

const mask = (secret) => `${secret.slice(0, 6)}...`;

/** Keys, addresses, local user paths and attribution phrasing in text. Key matches are masked. */
function shapeFindings(text, { trailer = true } = {}) {
  const found = [];
  for (const pattern of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push({ rule: "key-shape", excerpt: mask(match[0]) });
    }
  }
  for (const match of text.matchAll(IPV4)) {
    const [a = 0, b = 0, c = 0, d = 0] = match.slice(1, 5).map(Number);
    const rule = classifyAddress(a, b, c, d);
    if (rule) found.push({ rule, excerpt: match[0] });
  }
  for (const pattern of USER_PATHS) {
    for (const match of text.matchAll(pattern)) {
      found.push({ rule: "local-user-path", excerpt: tidy(match[0].slice(0, 60)) });
    }
  }
  for (const pattern of ATTRIBUTION) {
    for (const match of text.matchAll(pattern)) {
      found.push({ rule: "ai-attribution", excerpt: tidy(match[0].slice(0, 60)) });
    }
  }
  if (trailer && TRAILER_LINE.test(text)) {
    found.push({ rule: "co-author trailer", excerpt: "trailer line with an address" });
  }
  return found;
}

function unique(found) {
  const seen = new Set();
  return found.filter((finding) => {
    const key = `${finding.rule}\0${finding.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What is wrong with one blob, as `{ rule, excerpt }`. Text only for the dash rule. */
function analyze(content) {
  const found = shapeFindings(content.text);
  if (!content.binary) {
    for (const match of content.text.matchAll(LONG_DASH)) {
      found.push({ rule: "long-dash", excerpt: around(content.text, match.index, 1) });
    }
  }
  return unique(found);
}

/** Paths an ignore rule covers, by .gitignore and .git/info/exclude only, never the user's own excludes. */
function ignoredPaths(repo, paths) {
  if (paths.length === 0) return new Map();
  const temp = mkdtempSync(join(tmpdir(), "scan-history-"));
  try {
    const empty = join(temp, "excludes");
    writeFileSync(empty, "");
    const out = git(
      repo,
      ["-c", `core.excludesFile=${empty}`, "check-ignore", "--no-index", "-v", "-z", "--stdin"],
      { input: `${paths.join("\0")}\0`, ok: [0, 1] },
    ).toString("utf8");
    const fields = out.split("\0");
    const hits = new Map();
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [source, line, pattern, path] = [
        fields[i],
        fields[i + 1],
        fields[i + 2],
        fields[i + 3],
      ];
      if (path === undefined || pattern === undefined || pattern.startsWith("!")) continue;
      hits.set(path, `${source}:${line}:${pattern}`);
    }
    return hits;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(options.repo);
  const commits = readCommits(repo);
  const pairs = readPairs(repo, commits);
  const violations = [];
  const report = (rule, commit, where, excerpt) =>
    violations.push({ rule, order: commit ? commit.index : -1, commit, where, excerpt });

  for (const commit of commits) {
    for (const problem of checkMessage(commit.message, MESSAGE_RULES, { verbatim: true })) {
      report(problem.rule, commit, "(message)", `line ${problem.line}`);
    }
    for (const finding of unique(shapeFindings(commit.message, { trailer: false }))) {
      report(finding.rule, commit, "(message)", finding.excerpt);
    }
  }

  const findings = new Map();
  const shas = [...new Set(pairs.map((pair) => pair.sha))];
  const sizes = readBlobs(repo, shas, (sha, buf) => {
    findings.set(sha, analyze(decode(buf)));
  });
  const mediaBlobs = new Set();
  for (const pair of pairs) {
    for (const finding of findings.get(pair.sha) ?? []) {
      report(finding.rule, pair.commit, pair.path, finding.excerpt);
    }
    const size = sizes.get(pair.sha) ?? 0;
    if (size > MAX_BLOB_BYTES) report("oversize-blob", pair.commit, pair.path, `${size} bytes`);
    if (MEDIA.test(pair.path)) mediaBlobs.add(pair.sha);
  }
  let mediaBytes = 0;
  for (const sha of mediaBlobs) mediaBytes += sizes.get(sha) ?? 0;

  const firstCommit = new Map();
  for (const pair of pairs)
    if (!firstCommit.has(pair.path)) firstCommit.set(pair.path, pair.commit);
  const paths = [...firstCommit.keys()];
  for (const [path, rule] of ignoredPaths(repo, paths)) {
    report("ignored-path", firstCommit.get(path), path, rule);
  }

  violations.sort((a, b) => a.order - b.order);
  for (const v of violations) {
    const id = v.commit ? v.commit.hash.slice(0, 7) : "-";
    console.log(`${v.rule} | ${id} | ${v.where} | ${v.excerpt}`);
  }
  const identities = [
    ...new Set(commits.flatMap((commit) => [commit.author, commit.committer])),
  ].sort();
  for (const who of identities) console.log(`identity: ${who}`);
  console.log(
    `scan-history: commits=${commits.length} blobs=${shas.length} paths=${paths.length} identities=${identities.length} violations=${violations.length} media-bytes=${mediaBytes}`,
  );
  return violations.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof ScanError) {
    console.error(`scan-history: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
