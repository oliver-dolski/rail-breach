import { describe, expect, it } from "vitest";
import { createAttractSession } from "../../src/app/session";
import { network } from "../../src/content/network";
import { techniques } from "../../src/content/techniques";
import type { Content } from "../../src/content/types";
import { ContentError, validateContent, validateTechniques } from "../../src/content/validate";
import type { TechniqueDef } from "../../src/core/attack/types";

const base = techniques[0] as TechniqueDef;

const problemsOf = (run: () => void): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof ContentError) return error.problems;
    throw error;
  }
  return [];
};

const techProblems = (defs: readonly TechniqueDef[]): readonly string[] =>
  problemsOf(() => validateTechniques(defs, network));

describe("validateTechniques", () => {
  it("accepts the committed catalogue", () => {
    expect(techProblems(techniques)).toEqual([]);
  });

  it("rejects a duration whose max is below its min, which would make the jitter NaN", () => {
    expect(techProblems([{ ...base, durationTicks: [50, 30] }]).join(" ")).toMatch(/durationTicks/);
    expect(techProblems([{ ...base, durationTicks: [0, 5] }]).join(" ")).toMatch(/durationTicks/);
    expect(techProblems([{ ...base, durationTicks: [1.5, 5] }]).join(" ")).toMatch(/durationTicks/);
  });

  it("rejects a success chance outside 0..1000 permille", () => {
    expect(techProblems([{ ...base, successPermille: 1001 }]).join(" ")).toMatch(/successPermille/);
    expect(techProblems([{ ...base, successPermille: -1 }]).join(" ")).toMatch(/successPermille/);
    expect(techProblems([{ ...base, successPermille: 99.5 }]).join(" ")).toMatch(/successPermille/);
  });

  it("rejects duplicate ids and a legacy id that collides with another technique", () => {
    expect(techProblems([base, { ...base }]).join(" ")).toMatch(/already taken/);
    const other = techniques[1] as TechniqueDef;
    const clash = { ...other, legacyId: base.id };
    expect(techProblems([base, clash]).join(" ")).toMatch(/legacy id .* already taken/);
    expect(techProblems([{ ...base, legacyId: base.id }]).join(" ")).toMatch(/already taken/);
  });

  it("rejects effect parameters the engine cannot honour", () => {
    const withEffects = (effects: TechniqueDef["effects"]): TechniqueDef => ({ ...base, effects });
    expect(techProblems([withEffects([{ k: "discover", hops: -1 }])]).join(" ")).toMatch(/hops/);
    expect(
      techProblems([withEffects([{ k: "blockCommands", onTag: "no-such-tag" }])]).join(" "),
    ).toMatch(/no-such-tag/);
  });

  it("reports every problem at once", () => {
    const bad = { ...base, durationTicks: [9, 1] as [number, number], successPermille: 2000 };
    expect(techProblems([bad]).length).toBe(2);
  });
});

describe("validateContent: awarenessPermille", () => {
  const withAwareness = (value: number): Content => ({
    ...network,
    nodes: network.nodes.map((n, i) => (i === 0 ? { ...n, awarenessPermille: value } : n)),
  });

  it("rejects a value that would turn the success chance negative", () => {
    expect(problemsOf(() => validateContent(withAwareness(1200))).join(" ")).toMatch(
      /awarenessPermille/,
    );
    expect(problemsOf(() => validateContent(withAwareness(-5))).join(" ")).toMatch(
      /awarenessPermille/,
    );
    expect(problemsOf(() => validateContent(withAwareness(600)))).toEqual([]);
  });
});

describe("the attract session", () => {
  it("refuses content with an out-of-range awareness instead of playing a technique that can never succeed", () => {
    const bad: Content = {
      ...network,
      nodes: network.nodes.map((n, i) => (i === 0 ? { ...n, awarenessPermille: 1200 } : n)),
    };
    expect(() => createAttractSession({ content: bad })).toThrow(ContentError);
  });
});
