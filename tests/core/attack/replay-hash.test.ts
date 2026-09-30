import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../../../src/app/catalog";
import { network } from "../../../src/content/network";
import { stateHash } from "../../../src/core/hash";
import { captureRecording } from "../../../src/core/replay/capture";
import { assertRecording, type Recording } from "../../../src/core/replay/recording";
import { createRunner, ReplayMismatchError } from "../../../src/core/replay/runner";
import { RecordedSource } from "../../../src/core/replay/source";
import { createWorld } from "../../../src/core/sim/world";
import { networkIndex } from "../../fixtures/attack";

const index = networkIndex();

/**
 * Vendor and product names stay out of tracked code. When this machine has the
 * untracked deny list, its phrases are added to the leak guard from there.
 */
function localDeniedPhrases(): string[] {
  const file = ".git/info/commit-msg-deny";
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
}

function load(recordingJson: unknown): Recording {
  const value: unknown = JSON.parse(JSON.stringify(recordingJson));
  assertRecording(value);
  return value;
}

function replay(recording: Recording, chunks: readonly number[]) {
  const runner = createRunner(
    createWorld(network, recording.seed),
    new RecordedSource(recording),
    index,
  );
  for (const n of chunks) runner.advance(n);
  return runner;
}

/** A render loop hands the engine 0, 1 or 2 ticks per frame depending on frame time. */
function frameChunks(total: number): number[] {
  const pattern = [1, 2, 0, 1, 1, 3, 0, 2, 1];
  const chunks: number[] = [];
  let left = total;
  for (let i = 0; left > 0; i++) {
    const n = Math.min(pattern[i % pattern.length] ?? 1, left);
    chunks.push(n);
    left -= n;
  }
  return chunks;
}

/** The exact keys each kind of recorded action may carry: a committed recording holds nothing else. */
const ACTION_KEYS: Record<string, string[]> = {
  "technique.launch": ["target", "technique", "type"],
  "playbook.start": ["steps", "type"],
  "assume.breach": ["node", "type"],
  "defense.place": ["kind", "on", "type"],
};

it("has a committed recording for every scenario and no other", () => {
  expect(catalog.map((e) => e.scenario.id)).toEqual([
    "phishing-dispatcher",
    "vendor-vpn",
    "insider-signalbox",
  ]);
  for (const entry of catalog) expect(entry.recording, entry.scenario.id).toBeDefined();
});

describe.each(catalog)("the recorded $scenario.id session", ({ scenario, recording: json }) => {
  const recording = load(json);

  it("is a valid recording of the scenario", () => {
    expect(recording.seed).toBe(scenario.seed);
    expect(recording.durationTicks).toBe(scenario.durationTicks);
    expect(recording.actions).toEqual(scenario.actions);
    expect(recording.checkpoints.map((c) => c.t)).toEqual(
      Array.from({ length: scenario.durationTicks / 100 }, (_, i) => (i + 1) * 100),
    );
  });

  it("is what the engine produces today (regenerate with npm run recordings:regen)", () => {
    const fresh = captureRecording(
      createWorld(network, scenario.seed),
      index,
      scenario.actions,
      scenario.durationTicks,
    );
    expect(fresh).toEqual(recording);
  });

  it("replays to every recorded checkpoint hash, and the runner verifies each one", () => {
    const runner = replay(recording, [recording.durationTicks]);
    expect(runner.checkpoints()).toEqual(recording.checkpoints);
  });

  // Four full replays per scenario: about a second alone, several times that beside other files.
  it("ends on the same hash one tick at a time, in 100-tick chunks and in frame-sized steps", {
    timeout: 60_000,
  }, () => {
    const whole = stateHash(replay(recording, [recording.durationTicks]).view());
    const oneByOne = replay(recording, Array(recording.durationTicks).fill(1));
    const hundreds = replay(recording, Array(recording.durationTicks / 100).fill(100));
    const frames = replay(recording, frameChunks(recording.durationTicks));
    for (const runner of [oneByOne, hundreds, frames]) {
      expect(stateHash(runner.view())).toBe(whole);
      expect(runner.checkpoints()).toEqual(recording.checkpoints);
    }
  });

  it("never reaches for the network while replaying", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("the replay must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      replay(recording, [recording.durationTicks]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("diverges loudly when an action is moved", () => {
    const kinds = recording.actions.map((x) => x.a.type);
    const moved = Math.max(
      kinds.lastIndexOf("technique.launch"),
      kinds.lastIndexOf("playbook.start"),
    );
    const tampered: Recording = {
      ...recording,
      actions: recording.actions.map((x, i) => (i === moved ? { ...x, t: x.t + 100 } : x)),
    };
    expect(() => replay(tampered, [recording.durationTicks])).toThrow(ReplayMismatchError);
  });
});

describe.each(catalog)(
  "what the $scenario.id recording file is allowed to hold",
  ({ recording: json }) => {
    const text = JSON.stringify(json);
    const value = json as Record<string, unknown>;
    const actions = (json as { actions: { t: number; a: Record<string, unknown> }[] }).actions;
    const checkpoints = (json as { checkpoints: { t: number; h: string }[] }).checkpoints;

    it("has exactly the format header, seed, timed resolved actions and checkpoints", () => {
      expect(Object.keys(value).sort()).toEqual(
        ["actions", "checkpoints", "durationTicks", "format", "schema", "seed", "tickMs"].sort(),
      );
      const nodeIds = new Set(network.nodes.map((n) => n.id));
      const conduitIds = new Set(network.conduits.map((c) => c.id));
      const techniqueId = /^T\d{4}(\.\d{3})?$/;
      for (const item of actions) {
        expect(Object.keys(item).sort()).toEqual(["a", "t"]);
        const type = String(item.a.type);
        expect(Object.keys(item.a).sort(), type).toEqual(ACTION_KEYS[type]);
        if (type === "technique.launch") {
          expect(String(item.a.technique)).toMatch(techniqueId);
          expect(nodeIds.has(String(item.a.target))).toBe(true);
        } else if (type === "assume.breach") {
          expect(nodeIds.has(String(item.a.node))).toBe(true);
          expect(item.t).toBe(1);
        } else if (type === "defense.place") {
          expect(item.a.kind).toBe("ids");
          expect(conduitIds.has(String((item.a.on as { conduit: string }).conduit))).toBe(true);
        } else {
          // A playbook: steps of a technique id and, at most, one named node.
          for (const step of item.a.steps as { technique: string; target?: { node: string } }[]) {
            expect(Object.keys(step).sort()).toEqual(["target", "technique"]);
            expect(step.technique).toMatch(techniqueId);
            expect(Object.keys(step.target ?? {})).toEqual(["node"]);
            expect(nodeIds.has(step.target?.node ?? "")).toBe(true);
          }
        }
      }
      for (const c of checkpoints) {
        expect(Object.keys(c).sort()).toEqual(["h", "t"]);
        expect(c.h).toMatch(/^[0-9a-f]{8}$/);
      }
    });

    it("carries no key, free text, model output or note", () => {
      const generic =
        "api|key|token|secret|password|sk-|model|prompt|transcript|completion|text|note|title|meta";
      const leak = new RegExp([generic, ...localDeniedPhrases()].join("|"), "i");
      expect(text).not.toMatch(leak);
    });

    it("stays ASCII with no long dashes", () => {
      expect(text).toMatch(/^[\x20-\x7e]*$/);
    });
  },
);
