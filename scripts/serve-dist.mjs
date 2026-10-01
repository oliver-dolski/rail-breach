// Static server that answers the way a GitHub Pages project site does, so the smoke test
// checks the real topology and not the friendlier Vite preview server: the site lives under a
// subpath, only files are served, there is no SPA fallback and no custom header (the meta CSP in
// index.html has to hold on its own). Usage: node scripts/serve-dist.mjs [--port N]
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

const PLAIN = { "content-type": "text/plain; charset=utf-8" };

function reply(res, status, body, headers = PLAIN) {
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Resolve a URL path below the base to a file inside root, or null when it leaves root.
 * The path is decoded first, so %2e%2e is refused exactly like "..".
 */
function resolveFile(root, relative) {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = resolve(root, decoded.replace(/^\/+/, ""));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function fileAt(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return fileAt(join(target, "index.html"));
    return info.isFile() ? target : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ root: string, base: string }} options base is the URL subpath with both slashes,
 * for example "/rail-breach/".
 */
export function createPagesServer({ root, base }) {
  const absRoot = resolve(root);
  const bareBase = base.replace(/\/+$/, "");
  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply(res, 405, "Method Not Allowed", { ...PLAIN, allow: "GET, HEAD" });
      return;
    }
    const path = (req.url ?? "/").split("?")[0].split("#")[0];
    if (path === bareBase) {
      reply(res, 301, "", { ...PLAIN, location: base });
      return;
    }
    if (!path.startsWith(base)) {
      reply(res, 404, "Not Found");
      return;
    }
    const target = resolveFile(absRoot, path.slice(base.length));
    const file = target ? await fileAt(target) : null;
    if (!file) {
      reply(res, 404, "Not Found");
      return;
    }
    const body = await readFile(file);
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

/** Start the server on 127.0.0.1 only and resolve with it and the port it got. */
export function listen(server, port = 0) {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server.address().port));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--port");
  const port = flag === -1 ? 4173 : Number(process.argv[flag + 1]);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const base = "/rail-breach/";
  const bound = await listen(createPagesServer({ root, base }), port);
  console.log(`serving dist/ at http://127.0.0.1:${bound}${base}`);
}
