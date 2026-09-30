import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../vite.config";

function policyOf(html: string): Map<string, string[]> {
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  if (meta?.[1] === undefined) throw new Error("the page has no Content-Security-Policy meta");
  const directives = new Map<string, string[]>();
  for (const part of meta[1].split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

const pages: [string, string][] = [["index.html", "index.html"]];
if (existsSync("dist/index.html")) pages.push(["the built dist/index.html", "dist/index.html"]);

describe.each(pages)("the CSP of %s", (_, path) => {
  const policy = policyOf(readFileSync(path, "utf-8"));

  it("lets the page talk to itself and the provider's API host, and nothing else", () => {
    expect(policy.get("connect-src")).toEqual(["'self'", "https://api.anthropic.com"]);
  });

  it("keeps scripts and styles to the page's own files, with no inline allowance", () => {
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    for (const sources of policy.values()) {
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("'unsafe-eval'");
      expect(sources).not.toContain("*");
    }
  });

  it("keeps every other directive as it was", () => {
    expect(Object.fromEntries(policy)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://api.anthropic.com"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'none'"],
    });
  });
});

describe("the dev server's relaxation", () => {
  it("still applies on top of the page's policy, keeps the provider host, and only in dev", () => {
    const plugin = (config.plugins ?? [])
      .flat()
      .find(
        (p): p is { name: string; apply: string; transformIndexHtml: (html: string) => string } =>
          typeof p === "object" && p !== null && "name" in p && p.name === "rail-breach-dev-csp",
      );
    expect(plugin?.apply).toBe("serve");
    const dev = policyOf(plugin?.transformIndexHtml(readFileSync("index.html", "utf-8")) ?? "");
    expect(dev.get("connect-src")).toEqual(["'self'", "ws:", "http:", "https://api.anthropic.com"]);
    expect(dev.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev.get("script-src")).toEqual(["'self'"]);
  });
});

describe("the built output", () => {
  it.skipIf(!existsSync("dist"))("holds no API key", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk("dist").filter((f) => /\.(js|html|css|json|svg)$/.test(f))) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(/sk-[a-z]{2,4}-[A-Za-z0-9_-]{20,}/);
    }
  });
});
