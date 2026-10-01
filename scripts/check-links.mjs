#!/usr/bin/env node
// Link checker for the README. Offline by default, so it can run in the test suite.
//
//   relative target   must be a file (or a directory with tracked files) that `git ls-files`
//                     lists: a link to an untracked file works on this machine and is dead on
//                     GitHub, which is exactly what the check is for
//   #anchor           must match a heading, slugged the way GitHub slugs it
//   --online          every absolute http(s) URL must answer 2xx or 3xx (GET, redirects
//                     followed, 10 s timeout, one retry), except the repository's own URLs
//   --live            also check those own URLs (use it after the first push)
//
// Usage: node scripts/check-links.mjs <file.md> [--online] [--live]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** URLs under these prefixes do not exist before the owner publishes the repository. */
export const OWN_PREFIXES = [
  "https://github.com/oliver-dolski/rail-breach",
  "https://oliver-dolski.github.io/rail-breach",
];

const TIMEOUT_MS = 10_000;

/** The markdown without fenced code blocks and inline code spans (links in code are text). */
function withoutCode(markdown) {
  const out = [];
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const mark = marker[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      out.push("");
    } else if (fence !== null) {
      out.push("");
    } else {
      out.push(line.replace(/`[^`]*`/g, ""));
    }
  }
  return out;
}

/** Every link and image target, nested badge links included, in document order. */
export function extractTargets(markdown) {
  const targets = [];
  for (const line of withoutCode(markdown)) {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]);
    for (const m of line.matchAll(/<(https?:\/\/[^>\s]+)>/g)) targets.push(m[1]);
  }
  return targets;
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors a document offers; a repeated heading gets -1, -2 and so on. */
export function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  for (const line of withoutCode(markdown)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const isOwn = (url) => OWN_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));

/**
 * Judges the offline rules. `tracked` is the set of git-tracked paths (repository-relative,
 * forward slashes); `file` is the markdown's own repository-relative path; `exists` tells a
 * missing file from an untracked one, for the message only.
 */
export function checkOffline(markdown, { file, tracked, exists = () => false }) {
  const failures = [];
  const own = anchors(markdown);
  const dir = posix.dirname(file);
  for (const target of new Set(extractTargets(markdown))) {
    if (/^(https?:|mailto:)/i.test(target)) continue;
    const [pathPart, anchor] = target.split("#");
    if (pathPart === "") {
      if (anchor !== undefined && !own.has(anchor)) failures.push(`${target}: no such heading`);
      continue;
    }
    const full = posix.normalize(posix.join(dir === "." ? "" : dir, decodeURI(pathPart)));
    const bare = full.replace(/\/$/, "");
    const isTracked = tracked.has(bare) || [...tracked].some((t) => t.startsWith(`${bare}/`));
    if (!isTracked) {
      failures.push(
        `${target}: ${exists(bare) ? "exists but is not tracked by git" : "no such file"}`,
      );
    }
  }
  return failures;
}

async function answers(url, fetchImpl) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "rail-breach-link-check" },
      });
      if (res.status >= 200 && res.status < 400) return null;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  return last;
}

/** Online rules. Returns { failures, pending } for the absolute URLs of the document. */
export async function checkOnline(markdown, { live = false, fetchImpl = fetch } = {}) {
  const failures = [];
  const pending = [];
  const urls = [...new Set(extractTargets(markdown).filter((t) => /^https?:/i.test(t)))];
  for (const url of urls) {
    if (!live && isOwn(url)) {
      pending.push(url);
      continue;
    }
    const problem = await answers(url, fetchImpl);
    if (problem !== null) failures.push(`${url}: ${problem}`);
  }
  return { failures, pending };
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return new Set(out.split("\0").filter(Boolean));
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const online = argv.includes("--online") || argv.includes("--live");
  const live = argv.includes("--live");
  if (args.length !== 1) {
    console.error("usage: node scripts/check-links.mjs <file.md> [--online] [--live]");
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const abs = resolve(root, args[0]);
  const file = posix.normalize(abs.slice(root.length + 1).replaceAll("\\", "/"));
  const markdown = readFileSync(abs, "utf8");
  const tracked = trackedFiles(root);
  const failures = checkOffline(markdown, {
    file,
    tracked,
    exists: (p) => existsSync(resolve(root, p)),
  });
  let pending = [];
  if (online) {
    const result = await checkOnline(markdown, { live });
    failures.push(...result.failures);
    pending = result.pending;
  }
  for (const url of pending) console.log(`pending publication: ${url}`);
  for (const failure of failures) console.error(`FAIL ${file}: ${failure}`);
  const count = extractTargets(markdown).length;
  console.log(
    `check-links: ${file} targets=${count} failures=${failures.length} pending=${pending.length}${online ? " online" : " offline"}`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
