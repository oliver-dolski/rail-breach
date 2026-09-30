import { describe, expect, it } from "vitest";
import { h } from "../../src/ui/dom";

/** A document that records attributes; h() only needs createElement, setAttribute and append. */
function fakeDoc(): Document {
  return {
    createElement: () => {
      const attrs: Record<string, string> = {};
      return {
        attrs,
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        append: () => undefined,
      };
    },
  } as unknown as Document;
}

const attrsOf = (el: unknown): Record<string, string> =>
  (el as { attrs: Record<string, string> }).attrs;

describe("h()", () => {
  it("sets ordinary attributes", () => {
    const el = h(fakeDoc(), "div", { class: "x", "data-key": "op1", "aria-label": "y" });
    expect(attrsOf(el)).toEqual({ class: "x", "data-key": "op1", "aria-label": "y" });
  });

  it("refuses event handlers, inline style and srcdoc", () => {
    for (const name of ["onclick", "onerror", "style", "srcdoc"]) {
      expect(() => h(fakeDoc(), "div", { [name]: "x" })).toThrow(/not allowed/);
    }
  });

  it("refuses script-bearing URLs in href, src and form targets, however they are dressed", () => {
    const hostile = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "\tjavascript:alert(1)",
      "data:text/html,<script>1</script>",
      "//evil.test/x",
      "http://plain.test/x",
    ];
    for (const name of ["href", "src", "action", "formaction", "HREF"]) {
      for (const value of hostile) {
        expect(() => h(fakeDoc(), "a", { [name]: value }), `${name}=${value}`).toThrow(
          /does not accept/,
        );
      }
    }
  });

  it("accepts local, fragment and https URLs", () => {
    const el = h(fakeDoc(), "a", { href: "/fallback.svg" });
    expect(attrsOf(el).href).toBe("/fallback.svg");
    expect(() => h(fakeDoc(), "a", { href: "#top" })).not.toThrow();
    expect(() => h(fakeDoc(), "a", { href: "https://example.test/x" })).not.toThrow();
  });
});
