import { describe, expect, it } from "vitest";
import { createKeystore, type KeyStorage } from "../../src/app/keystore";
import {
  createKeyPanel,
  STATUS_BAD_KEY,
  STATUS_KEY,
  STATUS_NO_STORAGE,
} from "../../src/ui/panel/llmkey";

const KEY = "sk-test-0123456789abcdefghijklmnop";

function fakePage() {
  const make = () => {
    const listeners = new Map<string, ((event: { key?: string }) => void)[]>();
    return {
      value: "",
      textContent: "",
      disabled: false,
      append() {},
      setAttribute() {},
      addEventListener(type: string, fn: (event: { key?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      fire(type: string) {
        for (const fn of listeners.get(type) ?? []) fn({});
      },
    };
  };
  const byId = new Map<string, ReturnType<typeof make>>();
  for (const id of ["llm-key", "llm-save", "llm-forget", "llm-model", "llm-status"]) {
    byId.set(id, make());
  }
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: make,
  } as unknown as Document;
  return { doc, get: (id: string) => byId.get(id) as ReturnType<typeof make> };
}

const memory = (): KeyStorage => {
  const items = new Map<string, string>();
  return {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
  };
};

describe("the key panel's status line", () => {
  it("says a badly shaped key is not a key", () => {
    const { doc, get } = fakePage();
    const shared = memory();
    createKeyPanel(
      doc,
      createKeystore(() => shared),
    );
    get("llm-key").value = "short";
    get("llm-save").fire("click");
    expect(get("llm-status").textContent).toBe(STATUS_BAD_KEY);
    expect(get("llm-key").value).toBe("");
  });

  it("blames the browser, not the key, when storage is blocked", () => {
    const { doc, get } = fakePage();
    createKeyPanel(
      doc,
      createKeystore(() => {
        throw new Error("SecurityError");
      }),
    );
    get("llm-key").value = KEY;
    get("llm-save").fire("click");
    expect(get("llm-status").textContent).toBe(STATUS_NO_STORAGE);
    expect(get("llm-status").textContent).not.toMatch(/look like/);
  });

  it("reports a stored key as held", () => {
    const { doc, get } = fakePage();
    const shared = memory();
    createKeyPanel(
      doc,
      createKeystore(() => shared),
    );
    get("llm-key").value = KEY;
    get("llm-save").fire("click");
    expect(get("llm-status").textContent).toBe(STATUS_KEY);
  });
});
