import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { buildFallbackSvg, stillTrains } from "../../src/render/fallbackSvg";
import { detectWebgl2 } from "../../src/render/gl/context";
import { FALLBACK_MESSAGE, showFallback } from "../../src/ui/fallback";

describe("detectWebgl2", () => {
  it("reports not ok when the browser returns no WebGL2 context", () => {
    const getContext = vi.fn(() => null);
    const result = detectWebgl2({ getContext });
    expect(result.ok).toBe(false);
    expect(result.gl).toBeUndefined();
    expect(result.reason).toMatch(/WebGL2/);
  });

  it("asks for hardware rendering only, so a software context is refused", () => {
    const getContext = vi.fn(() => null);
    detectWebgl2({ getContext });
    expect(getContext).toHaveBeenCalledWith(
      "webgl2",
      expect.objectContaining({ failIfMajorPerformanceCaveat: true }),
    );
  });

  it("does not throw when creating the context throws", () => {
    const result = detectWebgl2({
      getContext: () => {
        throw new Error("context creation blocked");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("context creation blocked");
  });

  it("returns the context when the browser provides one", () => {
    const gl = {};
    const result = detectWebgl2({ getContext: () => gl });
    expect(result.ok).toBe(true);
    expect(result.gl).toBe(gl);
  });
});

describe("the no-WebGL2 page", () => {
  it("swaps the canvas for the still and an explanation, and leaves the panel alone", () => {
    const els = {
      canvas: { hidden: false as boolean | string },
      labels: { hidden: false as boolean | string },
      fallback: { hidden: true as boolean | string },
      message: { textContent: "" as string | null },
    };
    const panel = { hidden: false };
    showFallback(els, "no hardware WebGL2");
    expect(els.canvas.hidden).toBe(true);
    expect(els.labels.hidden).toBe(true);
    expect(els.fallback.hidden).toBe(false);
    expect(els.message.textContent).toContain(FALLBACK_MESSAGE);
    expect(els.message.textContent).toContain("no hardware WebGL2");
    expect(panel.hidden).toBe(false);
  });

  it("carries the reason as text, never as markup", () => {
    let html = "";
    const message = {
      textContent: "" as string | null,
      set innerHTML(v: string) {
        html = v;
      },
    };
    showFallback(
      { canvas: { hidden: false }, labels: { hidden: false }, fallback: { hidden: true }, message },
      "<img src=x onerror=alert(1)>",
    );
    expect(html).toBe("");
    expect(message.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("the static still", () => {
  const committed = readFileSync("public/fallback.svg", "utf8");

  it("is what the layout produces today (regenerate with npm run fallback:regen)", () => {
    expect(committed).toBe(buildFallbackSvg(layout, network));
  });

  it("is a self-contained SVG with a title, plain ASCII and no long dashes", () => {
    expect(committed).toMatch(/^<svg [^>]*viewBox="0 0 1600 900"/);
    expect(committed).toContain("<title>");
    expect(committed.replaceAll("\n", "")).toMatch(/^[ -~]*$/);
    expect(committed).not.toMatch(/(https?:)?\/\/(?!www\.w3\.org)/);
    expect(committed).not.toMatch(/<script|onload=|onerror=/i);
  });

  it("shows the railway and the machines, not an empty frame", () => {
    for (const station of layout.stations) expect(committed).toContain(station.name);
    for (const zone of layout.zones) expect(committed).toContain(zone.label);
  });
});

describe("the page shell", () => {
  const html = readFileSync("index.html", "utf8");

  it("allows only its own origin in the content security policy", () => {
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/https?:|\*|unsafe-eval/);
  });

  it("pulls in no third-party script, style or font", () => {
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)/);
  });

  it("has the canvas, the labels layer, the fallback and the always-present indicator", () => {
    for (const id of [
      "map",
      "labels",
      "fallback",
      "fallback-message",
      "indicator-label",
      "panel",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // Never claims HELD before the core has been asked.
    expect(/id="indicator-label"[^>]*>\s*([^<]*)</.exec(html)?.[1]).not.toMatch(/HELD/);
  });

  it("ships the Pages marker and a base-relative favicon and fallback", () => {
    expect(existsSync("public/.nojekyll")).toBe(true);
    expect(existsSync("public/favicon.svg")).toBe(true);
    expect(html).toContain('src="/fallback.svg"');
  });
});

describe("the trains in the still", () => {
  /** Distance from a point to the nearest segment of a polyline. */
  function distanceToPolyline(
    p: { x: number; y: number },
    pts: readonly { x: number; y: number }[],
  ): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
      const t = Math.min(
        1,
        Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2),
      );
      best = Math.min(
        best,
        Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)),
      );
    }
    return best;
  }

  it("sit on the track of their block, including the bent branch block", () => {
    const trains = stillTrains(layout);
    expect(trains.map((t) => t.block)).toContain("BR_up");
    for (const t of trains) {
      const pts = layout.blocks[t.block] ?? [];
      const middle = { x: (t.x1 + t.x2) / 2, y: (t.y1 + t.y2) / 2 };
      expect(distanceToPolyline(middle, pts), t.block).toBeLessThan(0.5);
    }
  });

  it("have the same visible length whatever way their block runs", () => {
    for (const t of stillTrains(layout)) {
      expect(Math.hypot(t.x2 - t.x1, t.y2 - t.y1), t.block).toBeCloseTo(18, 5);
    }
  });
});
