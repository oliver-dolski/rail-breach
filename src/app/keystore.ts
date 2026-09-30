/**
 * The only place the viewer's API key is read or written. It lives in sessionStorage, so
 * it dies with the tab, and nowhere else: not a recording, not a URL, not a log line, not
 * an error message. Nothing outside this module and the one call that sends it may touch
 * it, and the page never shows it again after it is entered.
 */

const STORAGE_KEY = "rail-breach.llm-key";

/** A key is printable ASCII without spaces, long enough to be one and short enough to be safe in a header. */
const KEY_SHAPE = /^[\x21-\x7e]{20,256}$/;

export interface KeyStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export interface Keystore {
  /** The key, or undefined when none is held (or storage is unavailable). */
  getKey(): string | undefined;
  /** Holds the key for this tab. False, and nothing stored, when it is not shaped like a key. */
  setKey(key: string): boolean;
  clearKey(): void;
  /** Calls `listener` after every change; returns a function that stops it. The key is never passed. */
  onChange(listener: () => void): () => void;
}

/** `storage` is looked up on every call, because reading sessionStorage can throw in some browsers. */
export function createKeystore(storage: () => KeyStorage | undefined): Keystore {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const safely = <T>(fn: (s: KeyStorage) => T): T | undefined => {
    try {
      const s = storage();
      return s === undefined ? undefined : fn(s);
    } catch {
      return undefined;
    }
  };
  return {
    getKey() {
      const held = safely((s) => s.getItem(STORAGE_KEY));
      return typeof held === "string" && KEY_SHAPE.test(held) ? held : undefined;
    },
    setKey(key) {
      const trimmed = key.trim();
      if (!KEY_SHAPE.test(trimmed)) return false;
      const stored = safely((s) => {
        s.setItem(STORAGE_KEY, trimmed);
        return true;
      });
      if (stored !== true) return false;
      notify();
      return true;
    },
    clearKey() {
      safely((s) => s.removeItem(STORAGE_KEY));
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The keystore of the running page: sessionStorage, looked up when used. */
export const keystore: Keystore = createKeystore(() =>
  typeof sessionStorage === "undefined" ? undefined : sessionStorage,
);
