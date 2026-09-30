import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeystore, type KeyStorage, keystore } from "../../src/app/keystore";

const KEY = "sk-test-0123456789abcdefghijklmnop";

function memory(): KeyStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the keystore", () => {
  it("holds a key, hands it back, and forgets it", () => {
    const shared = memory();
    const ks = createKeystore(() => shared);
    expect(ks.getKey()).toBeUndefined();
    expect(ks.setKey(KEY)).toBe("stored");
    expect(ks.getKey()).toBe(KEY);
    ks.clearKey();
    expect(ks.getKey()).toBeUndefined();
    expect(shared.items.size).toBe(0);
  });

  it("trims the key it is given", () => {
    const shared = memory();
    const ks = createKeystore(() => shared);
    expect(ks.setKey(`  ${KEY}\n`)).toBe("stored");
    expect(ks.getKey()).toBe(KEY);
  });

  it("refuses what is not shaped like a key, storing nothing", () => {
    const shared = memory();
    const ks = createKeystore(() => shared);
    for (const bad of [
      "",
      "short",
      "has a space in it 0123456789",
      `${KEY}\nX-Evil: 1`,
      "k".repeat(300),
      "é".repeat(30),
    ]) {
      expect(ks.setKey(bad), JSON.stringify(bad)).toBe("bad-shape");
    }
    expect(shared.items.size).toBe(0);
  });

  it("ignores a stored value that is not shaped like a key", () => {
    const shared = memory();
    shared.setItem("rail-breach.llm-key", "tampered value");
    expect(createKeystore(() => shared).getKey()).toBeUndefined();
  });

  it("uses sessionStorage of the page and never localStorage", () => {
    const session = memory();
    const local = memory();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);
    expect(keystore.setKey(KEY)).toBe("stored");
    expect(session.items.size).toBe(1);
    expect(local.items.size).toBe(0);
    keystore.clearKey();
    expect(session.items.size).toBe(0);
  });

  it("copes with storage that is missing or throws", () => {
    const missing = createKeystore(() => undefined);
    expect(missing.getKey()).toBeUndefined();
    expect(missing.setKey(KEY)).toBe("no-storage");
    expect(() => missing.clearKey()).not.toThrow();

    const throwing = createKeystore(() => {
      throw new Error("SecurityError");
    });
    expect(throwing.getKey()).toBeUndefined();
    expect(throwing.setKey(KEY)).toBe("no-storage");
    expect(() => throwing.clearKey()).not.toThrow();
  });

  it("tells listeners about a change without telling them the key", () => {
    const shared = memory();
    const ks = createKeystore(() => shared);
    const seen: unknown[][] = [];
    const stop = ks.onChange((...args) => seen.push(args));
    ks.setKey(KEY);
    ks.clearKey();
    stop();
    ks.setKey(KEY);
    expect(seen).toEqual([[], []]);
  });
});

describe("where the key may be touched", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const sources = walk("src").filter((f) => f.endsWith(".ts"));

  it("has no localStorage anywhere in the app", () => {
    for (const file of sources) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(/localStorage/);
    }
  });

  it("reads sessionStorage only in the keystore", () => {
    for (const file of sources.filter((f) => !f.endsWith("keystore.ts"))) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(/sessionStorage/);
    }
  });

  it("keeps the key out of recordings, the core and the URL", () => {
    for (const file of sources.filter((f) => /[\\/](core|recordings)[\\/]/.test(f))) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(/keystore|getKey|x-api-key/);
    }
    for (const file of sources) {
      expect(readFileSync(file, "utf-8"), file).not.toMatch(
        /location\.(search|hash|href)|URLSearchParams/,
      );
    }
  });
});
