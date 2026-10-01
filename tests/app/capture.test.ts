import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTURE_FRAME_MS, createManualFrames } from "../../src/app/capture";
import { startLoop } from "../../src/app/loop";

describe("the capture frame clock", () => {
  it("steps exactly 40 ms a frame, so N frames give floor((N - 1) * 40 / 100) ticks", () => {
    expect(CAPTURE_FRAME_MS).toBe(40);
    for (const n of [1, 2, 3, 25, 100, 1151]) {
      const manual = createManualFrames(CAPTURE_FRAME_MS);
      let rendered = 0;
      let ticks = 0;
      startLoop(
        { advance: (t) => (ticks += t) },
        () => {
          rendered += 1;
        },
        { deps: manual.deps },
      );
      for (let i = 0; i < n; i++) expect(manual.frame()).toBe(true);
      expect(manual.frames()).toBe(n);
      expect(rendered).toBe(n);
      expect(ticks).toBe(Math.floor(((n - 1) * CAPTURE_FRAME_MS) / 100));
    }
  });

  it("hands the loop whole-millisecond times with no wall clock in them", () => {
    const manual = createManualFrames(40);
    const times: number[] = [];
    manual.deps.request((t) => times.push(t));
    manual.frame();
    manual.deps.request((t) => times.push(t));
    manual.frame();
    manual.deps.request((t) => times.push(t));
    manual.frame();
    expect(times).toEqual([40, 80, 120]);
  });

  it("runs nothing after pause, and again after resume", () => {
    const manual = createManualFrames(CAPTURE_FRAME_MS);
    let rendered = 0;
    const loop = startLoop(
      { advance: () => undefined },
      () => {
        rendered += 1;
      },
      { deps: manual.deps },
    );
    manual.frame();
    manual.frame();
    expect(rendered).toBe(2);

    loop.pause();
    expect(manual.frame()).toBe(false);
    expect(rendered).toBe(2);

    loop.resume();
    expect(manual.frame()).toBe(true);
    expect(rendered).toBe(3);
  });

  it("cancels only the callback it handed out", () => {
    const manual = createManualFrames(40);
    let ran = 0;
    const first = manual.deps.request(() => {
      ran += 1;
    });
    manual.deps.request(() => {
      ran += 10;
    });
    manual.deps.cancel(first);
    manual.frame();
    expect(ran).toBe(10);
  });
});

/** Every .js file under dist, or nothing when the project has not been built. */
function builtScripts(): string[] {
  const dir = join("dist", "assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(dir, name));
}

describe("the production bundle", () => {
  const files = builtScripts();

  it.skipIf(files.length === 0)("carries no capture hook and no manual frame clock", () => {
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toContain("__railBreachCapture");
      expect(code, file).not.toContain("data-capture");
      expect(code, file).not.toMatch(/\bcapture\b.*\bdataset\b|dataset\.capture/);
    }
  });
});
