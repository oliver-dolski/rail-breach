import { describe, expect, it } from "vitest";
import { switchScenario } from "../../src/app/switch";

function harness(build: (id: string) => string | undefined) {
  const calls: string[] = [];
  const deps = {
    runningId: () => "a",
    build,
    adopt: (_s: string, id: string) => calls.push(`adopt:${id}`),
    restore: (id: string) => calls.push(`restore:${id}`),
    say: (text: string) => calls.push(`say:${text}`),
  };
  return { calls, run: (id: string) => switchScenario(id, deps) };
}

describe("switching scenario", () => {
  it("adopts the new session and clears any earlier message", () => {
    const h = harness((id) => `session-${id}`);
    h.run("b");
    expect(h.calls).toEqual(["adopt:b", "say:"]);
  });

  it("does nothing for the scenario that is already running", () => {
    const h = harness(() => "never");
    h.run("a");
    expect(h.calls).toEqual([]);
  });

  it("puts the selector back and says why when the new session cannot be built", () => {
    const h = harness(() => {
      throw new Error('scenario "b" aims T0865 at "il-vel", which it cannot target');
    });
    h.run("b");
    expect(h.calls).toEqual([
      "restore:a",
      'say:That scenario could not start, so the running one carries on: scenario "b" aims T0865 at "il-vel", which it cannot target',
    ]);
  });

  it("puts the selector back for an id that has no scenario", () => {
    const h = harness(() => undefined);
    h.run("zzz");
    expect(h.calls).toEqual(["restore:a"]);
  });
});
