import { describe, expect, it } from "vitest";
import { attempt } from "../../src/app/recovery";
import {
  BOOT_FAILED_MESSAGE,
  type PageDoc,
  RENDER_FAILED_MESSAGE,
  reportBootFailure,
  showFallback,
} from "../../src/ui/fallback";

function fakePage(
  ids: string[],
): PageDoc & { els: Map<string, { textContent: string | null; hidden: boolean | string }> } {
  const els = new Map(
    ids.map((id) => [id, { textContent: "", hidden: id === ("fallback" as string) }]),
  );
  return { els, getElementById: (id) => els.get(id) ?? null };
}

const PAGE_IDS = [
  "indicator-label",
  "indicator-detail",
  "map",
  "labels",
  "fallback",
  "fallback-message",
];

describe("a renderer that fails to start", () => {
  it("shows the still and the reason instead of leaving a blank map", () => {
    const els = {
      canvas: { hidden: false as boolean | string },
      labels: { hidden: false as boolean | string },
      fallback: { hidden: true as boolean | string },
      message: { textContent: "" as string | null },
    };
    const renderer = attempt(
      () => {
        throw new Error("shader failed to build: line 3");
      },
      (reason) => showFallback(els, reason, RENDER_FAILED_MESSAGE),
    );
    expect(renderer).toBeUndefined();
    expect(els.canvas.hidden).toBe(true);
    expect(els.fallback.hidden).toBe(false);
    expect(els.message.textContent).toContain(RENDER_FAILED_MESSAGE);
    expect(els.message.textContent).toContain("shader failed to build: line 3");
  });

  it("returns what was built when nothing throws", () => {
    expect(
      attempt(
        () => 7,
        () => undefined,
      ),
    ).toBe(7);
  });
});

describe("a failure anywhere in boot", () => {
  it("explains itself in the indicator and swaps in the still", () => {
    const page = fakePage(PAGE_IDS);
    reportBootFailure(page, new Error("layout has no node x"));
    expect(page.els.get("indicator-label")?.textContent).toBe("safety invariant: not checked");
    expect(page.els.get("indicator-detail")?.textContent).toContain("layout has no node x");
    expect(page.els.get("map")?.hidden).toBe(true);
    expect(page.els.get("fallback")?.hidden).toBe(false);
    expect(page.els.get("fallback-message")?.textContent).toContain(BOOT_FAILED_MESSAGE);
  });

  it("does not throw when the page itself is missing pieces", () => {
    const page = fakePage(["indicator-detail"]);
    expect(() => reportBootFailure(page, "not an Error")).not.toThrow();
    expect(page.els.get("indicator-detail")?.textContent).toContain("unknown error");
  });
});
