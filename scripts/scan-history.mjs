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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkMessage,
  denyRules,
  escapeRe,
  MESSAGE_RULES,
  parseDenyEntries,
  phraseRegex,
} from "./lib/hygiene.mjs";

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

/** The untracked lists under .git/info, by role. */
const LOCAL_FILES = {
  deny: "commit-msg-deny",
  literals: "history-scan-deny",
  allow: "history-scan-allow",
};
/** The characters around a single-word match that make up its token. */
const TOKEN_CHAR = /[A-Za-z0-9@._:/-]/;
const TOKEN_REACH = 120;

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
  if (shas.length === 0) return sizes;
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

/** Merges findings with the same rule and excerpt, counting how often each occurred. */
function unique(found) {
  const merged = new Map();
  for (const finding of found) {
    const key = `${finding.rule}\0${finding.excerpt}`;
    const known = merged.get(key);
    if (known) known.count += 1;
    else merged.set(key, { ...finding, count: 1 });
  }
  return [...merged.values()];
}

/** The longest run of token characters around a match: the unit the allow file declares. */
function tokenAround(text, start, length) {
  let from = start;
  let to = start + length;
  while (from > 0 && start - from < TOKEN_REACH && TOKEN_CHAR.test(text[from - 1] ?? "")) {
    from -= 1;
  }
  while (to < text.length && to - start - length < TOKEN_REACH && TOKEN_CHAR.test(text[to] ?? "")) {
    to += 1;
  }
  return text.slice(from, to);
}

/**
 * The local layers, built from the untracked lists. Each entry remembers the list and line it came
 * from, so output can point at it without repeating the phrase.
 *  - strong: deny phrases of several words or shaped like an address, fail anywhere.
 *  - single: one-word deny phrases, fail unless the token around them is declared for the path.
 *  - literals: employer and operator literals, fail anywhere; "cs:" means an exact whole word.
 *  - messageRules: all of the above as rules for checkMessage, the hook's own matcher.
 */
function buildLayers(local) {
  const layers = { strong: [], single: [], literals: [], messageRules: [] };
  for (const { phrase, line } of local.deny ?? []) {
    const entry = { re: phraseRegex(phrase, "gi"), source: `${LOCAL_FILES.deny} line ${line}` };
    if (/\s|@/.test(phrase)) layers.strong.push(entry);
    else layers.single.push(entry);
    layers.messageRules.push(...denyRules([phrase]));
  }
  for (const { phrase, line } of local.literals ?? []) {
    const exact = phrase.startsWith("cs:");
    const make = (flags) =>
      exact
        ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase.slice(3))}(?![A-Za-z0-9])`, flags)
        : phraseRegex(phrase, flags);
    layers.literals.push({
      re: make(exact ? "g" : "gi"),
      source: `${LOCAL_FILES.literals} line ${line}`,
    });
    layers.messageRules.push({ name: "operator-literal", re: make(exact ? "" : "i") });
  }
  return layers;
}

/**
 * Local-layer findings in a string. With `tokens`, a single word is reported as the token around it
 * (blobs, where the allow file can declare it); without, as the list line (paths and identities).
 */
function layerFindings(text, layers, { tokens = true } = {}) {
  const found = [];
  for (const [list, rule] of [
    [layers.strong, "denied-phrase"],
    [layers.literals, "operator-literal"],
  ]) {
    for (const { re, source } of list) {
      re.lastIndex = 0;
      if (re.test(text)) found.push({ rule, excerpt: source });
      re.lastIndex = 0;
    }
  }
  for (const { re, source } of layers.single) {
    for (const match of text.matchAll(re)) {
      if (!tokens) {
        found.push({ rule: "denied-phrase", excerpt: source });
        break;
      }
      const token = tokenAround(text, match.index, match[0].length);
      found.push({ rule: "denied-phrase", excerpt: token, token });
    }
  }
  return found;
}

/** What is wrong with one blob, as `{ rule, excerpt }`. Text only for the dash rule. */
function analyze(content, layers) {
  const found = [...shapeFindings(content.text), ...layerFindings(content.text, layers)];
  if (!content.binary) {
    for (const match of content.text.matchAll(LONG_DASH)) {
      found.push({ rule: "long-dash", excerpt: around(content.text, match.index, 1) });
    }
  }
  return unique(found);
}

/** Lines of path, a tab, the exact token and optionally a tab and a reason; # starts a comment. */
function parseAllow(text) {
  const allowed = new Map();
  let entries = 0;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) return;
    const [path = "", token = ""] = raw.split("\t").map((field) => field.trim());
    if (path === "" || token === "") {
      throw new ScanError(
        `${LOCAL_FILES.allow} line ${index + 1}: expected a path, a tab and the exact token`,
      );
    }
    const tokens = allowed.get(path) ?? new Set();
    tokens.add(token);
    allowed.set(path, tokens);
    entries += 1;
  });
  return { allowed, entries };
}

/** Reads the three lists of the scanned repository; a file that does not exist is null. */
function readLocal(repo) {
  const text = {};
  for (const [role, name] of Object.entries(LOCAL_FILES)) {
    const path = gitText(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      `info/${name}`,
    ]);
    text[role] = existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return {
    deny: text.deny === null ? null : parseDenyEntries(text.deny),
    literals: text.literals === null ? null : parseDenyEntries(text.literals),
    allow: text.allow === null ? null : parseAllow(text.allow),
  };
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

const LAYER_NAMES = { deny: "deny-phrase", literals: "operator-literal" };

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(options.repo);
  const local = readLocal(repo);
  const layers = buildLayers(local);
  const commits = readCommits(repo);
  const pairs = readPairs(repo, commits);
  const violations = [];
  const report = (rule, commit, where, excerpt) =>
    violations.push({ rule, order: commit ? commit.index : -1, commit, where, excerpt });

  for (const [role, name] of Object.entries(LOCAL_FILES)) {
    if (local[role] !== null) continue;
    if (options.requireLocal && !options.inventory) {
      report("missing-local-file", null, `.git/info/${name}`, "required by --require-local");
    } else if (role !== "allow") {
      console.error(
        `WARNING: .git/info/${name} not found, the ${LAYER_NAMES[role]} layer is skipped`,
      );
    }
  }
  if (gitText(repo, ["rev-parse", "--is-shallow-repository"]) === "true") {
    report("shallow-repository", null, "(repository)", "history is incomplete, fetch all of it");
  }

  const allowed = local.allow?.allowed ?? new Map();
  const findings = new Map();
  const shas = [...new Set(pairs.map((pair) => pair.sha))];
  const sizes = readBlobs(repo, shas, (sha, buf) => {
    findings.set(sha, analyze(decode(buf), layers));
  });

  if (options.inventory) {
    return inventory(pairs, findings, allowed);
  }

  const messageRules = [...MESSAGE_RULES, ...layers.messageRules];
  const identityFirst = new Map();
  for (const commit of commits) {
    for (const problem of checkMessage(commit.message, messageRules, { verbatim: true })) {
      report(problem.rule, commit, "(message)", `line ${problem.line}`);
    }
    for (const finding of unique(shapeFindings(commit.message, { trailer: false }))) {
      report(finding.rule, commit, "(message)", finding.excerpt);
    }
    for (const [role, who] of [
      ["(author)", commit.author],
      ["(committer)", commit.committer],
    ]) {
      const key = `${role}\0${who}`;
      if (!identityFirst.has(key)) identityFirst.set(key, { role, who, commit });
    }
  }
  for (const { role, who, commit } of identityFirst.values()) {
    for (const finding of layerFindings(who, layers, { tokens: false })) {
      report(finding.rule, commit, role, finding.excerpt);
    }
  }

  const mediaBlobs = new Set();
  for (const pair of pairs) {
    const declared = allowed.get(pair.path);
    for (const finding of findings.get(pair.sha) ?? []) {
      if (finding.token !== undefined && declared?.has(finding.token)) continue;
      report(finding.rule, pair.commit, pair.path, finding.excerpt);
    }
    const size = sizes.get(pair.sha) ?? 0;
    if (size > MAX_BLOB_BYTES) report("oversize-blob", pair.commit, pair.path, `${size} bytes`);
    if (MEDIA.test(pair.path)) mediaBlobs.add(pair.sha);
  }
  let mediaBytes = 0;
  for (const sha of mediaBlobs) mediaBytes += sizes.get(sha) ?? 0;

  const firstCommit = new Map();
  for (const pair of pairs) {
    if (!firstCommit.has(pair.path)) firstCommit.set(pair.path, pair.commit);
  }
  const paths = [...firstCommit.keys()];
  for (const path of paths) {
    for (const finding of layerFindings(path, layers, { tokens: false })) {
      report(finding.rule, firstCommit.get(path), path, finding.excerpt);
    }
  }
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
  const count = (list) => (list === null ? "absent" : String(list.length ?? list.entries));
  console.log(
    `local-layers: ${LOCAL_FILES.deny}=${count(local.deny)} ${LOCAL_FILES.literals}=${count(local.literals)} ${LOCAL_FILES.allow}=${count(local.allow)}`,
  );
  console.log(
    `scan-history: commits=${commits.length} blobs=${shas.length} paths=${paths.length} identities=${identities.length} violations=${violations.length} media-bytes=${mediaBytes}`,
  );
  return violations.length === 0 ? 0 : 1;
}

/**
 * Lists every (path, token) occurrence of the single-word deny phrases, so the allow file can be
 * written from facts. `count` adds up the occurrences over every distinct revision of the path.
 */
function inventory(pairs, findings, allowed) {
  const rows = new Map();
  for (const pair of pairs) {
    for (const finding of findings.get(pair.sha) ?? []) {
      if (finding.token === undefined) continue;
      const key = `${pair.path}\0${finding.token}`;
      const row = rows.get(key) ?? {
        path: pair.path,
        token: finding.token,
        count: 0,
        commit: pair.commit,
        declared: allowed.get(pair.path)?.has(finding.token) === true,
      };
      row.count += finding.count;
      rows.set(key, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.token < b.token ? -1 : 1,
  );
  for (const row of sorted) {
    console.log(
      `inventory | ${row.commit.hash.slice(0, 7)} | ${row.path} | ${row.token} | count=${row.count} | declared=${row.declared ? "yes" : "no"}`,
    );
  }
  console.log(`scan-history: inventory entries=${sorted.length}`);
  return 0;
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
