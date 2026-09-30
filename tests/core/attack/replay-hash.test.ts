import { describe, expect, it, vi } from "vitest";
import { network } from "../../../src/content/network";
import { stateHash } from "../../../src/core/hash";
import { captureRecording } from "../../../src/core/replay/capture";
import { assertRecording, type Recording } from "../../../src/core/replay/recording";
import { createRunner, ReplayMismatchError } from "../../../src/core/replay/runner";
import { RecordedSource } from "../../../src/core/replay/source";
import { createWorld } from "../../../src/core/sim/world";
import recordingJson from "../../../src/recordings/phishing-dispatcher.json";
import { networkIndex, scenario } from "../../fixtures/attack";

const index = networkIndex();

function load(): Recording {
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

describe("the recorded phishing-dispatcher session", () => {
  const recording = load();

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

  it("ends on the same hash one tick at a time, in 100-tick chunks and in frame-sized steps", () => {
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
    const tampered: Recording = {
      ...recording,
      actions: recording.actions.map((x, i) => (i === 4 ? { ...x, t: x.t + 100 } : x)),
    };
    expect(() => replay(tampered, [recording.durationTicks])).toThrow(ReplayMismatchError);
  });
});

describe("what the recording file is allowed to hold", () => {
  const text = JSON.stringify(recordingJson);
  const value = recordingJson as unknown as Record<string, unknown>;

  it("has exactly the format header, seed, timed technique actions and checkpoints", () => {
    expect(Object.keys(value).sort()).toEqual(
      ["actions", "checkpoints", "durationTicks", "format", "schema", "seed", "tickMs"].sort(),
    );
    const nodeIds = new Set(network.nodes.map((n) => n.id));
    for (const item of recordingJson.actions) {
      expect(Object.keys(item).sort()).toEqual(["a", "t"]);
      expect(Object.keys(item.a).sort()).toEqual(["target", "technique", "type"]);
      expect(item.a.type).toBe("technique.launch");
      expect(item.a.technique).toMatch(/^T\d{4}(\.\d{3})?$/);
      expect(nodeIds.has(item.a.target), item.a.target).toBe(true);
    }
    for (const c of recordingJson.checkpoints) {
      expect(Object.keys(c).sort()).toEqual(["h", "t"]);
      expect(c.h).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("carries no key, free text, model output or note", () => {
    expect(text).not.toMatch(
      /api|key|token|secret|password|sk-|anthropic|claude|openai|model|prompt|transcript|completion|text|note|title|meta/i,
    );
  });

  it("stays ASCII with no long dashes", () => {
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
