/// <reference types="node" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagesServer, listen } from "../../scripts/serve-dist.mjs";

const BASE = "/rail-breach/";

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let root: string;
let server: Server;
let port: number;

/** A raw request: fetch would normalise "/../" away before the server saw it. */
function ask(method: string, path: string): Promise<Answer> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        done({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rail-breach-serve-"));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>root</title>");
  writeFileSync(join(root, "assets", "app.js"), "export const a = 1;");
  writeFileSync(join(root, "sub", "index.html"), "<!doctype html><title>sub</title>");
  server = createPagesServer({ root, base: BASE });
  port = await listen(server);
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

describe("Pages topology server", () => {
  it("serves index.html at the base", async () => {
    const answer = await ask("GET", BASE);
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("text/html");
    expect(answer.body).toContain("<title>root</title>");
  });

  it("serves a directory's index.html and assets with their types", async () => {
    expect((await ask("GET", `${BASE}sub/`)).body).toContain("<title>sub</title>");
    const js = await ask("GET", `${BASE}assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
  });

  it("redirects the base without its slash", async () => {
    const answer = await ask("GET", "/rail-breach");
    expect(answer.status).toBe(301);
    expect(answer.headers.location).toBe(BASE);
  });

  it("answers 404 outside the base, for a missing file and with no SPA fallback", async () => {
    for (const path of ["/", "/other/index.html", `${BASE}missing.js`, `${BASE}no/such/route`]) {
      const answer = await ask("GET", path);
      expect(answer.status, path).toBe(404);
      expect(answer.body).not.toContain("<title>");
    }
  });

  it("refuses traversal in plain and percent-encoded form, and NUL", async () => {
    writeFileSync(join(root, "..", "rail-breach-outside.txt"), "secret");
    try {
      for (const path of [
        `${BASE}../rail-breach-outside.txt`,
        `${BASE}%2e%2e/rail-breach-outside.txt`,
        `${BASE}%2E%2E%2Frail-breach-outside.txt`,
        `${BASE}index.html%00.js`,
        `${BASE}%`,
      ]) {
        const answer = await ask("GET", path);
        expect(answer.status, path).toBe(404);
        expect(answer.body).not.toContain("secret");
      }
    } finally {
      rmSync(join(root, "..", "rail-breach-outside.txt"), { force: true });
    }
  });

  it("allows GET and HEAD only", async () => {
    expect((await ask("POST", BASE)).status).toBe(405);
    expect((await ask("DELETE", `${BASE}index.html`)).status).toBe(405);
  });

  it("answers HEAD with the headers and no body", async () => {
    const answer = await ask("HEAD", BASE);
    expect(answer.status).toBe(200);
    expect(Number(answer.headers["content-length"])).toBeGreaterThan(0);
    expect(answer.body).toBe("");
  });

  it("sends no security header, as Pages does", async () => {
    const answer = await ask("GET", BASE);
    expect(answer.headers["content-security-policy"]).toBeUndefined();
    expect(answer.headers["x-frame-options"]).toBeUndefined();
  });
});
