import { describe, expect, it } from "vitest";
import { techniques } from "../../src/content/techniques";
import type { Content } from "../../src/content/types";
import { ContentError, validateContent } from "../../src/content/validate";
import { stateHash } from "../../src/core/hash";
import { assertRecording, RECORDING_SCHEMA, type Recording } from "../../src/core/replay/recording";
import { createRunner, ReplayMismatchError } from "../../src/core/replay/runner";
import { RecordedSource } from "../../src/core/replay/source";
import type { Action } from "../../src/core/sim/actions";
import { buildIndex } from "../../src/core/sim/model";
import { createWorld } from "../../src/core/sim/world";
import { tinyTopology } from "../fixtures/tiny-topology";

const SEED = 4242;
const index = buildIndex(tinyTopology, { techniques });

function bareRecording(actions: Recording["actions"], durationTicks: number): Recording {
  return {
    format: "rail-breach.recording",
    schema: RECORDING_SCHEMA,
    seed: SEED,
    tickMs: 100,
    durationTicks,
    actions,
    checkpoints: [],
  };
}

/** Records a session: runs the engine over the actions and captures its checkpoints. */
function record(actions: Recording["actions"], durationTicks: number): Recording {
  const bare = bareRecording(actions, durationTicks);
  const runner = createRunner(
    createWorld(tinyTopology, bare.seed),
    new RecordedSource(bare),
    index,
  );
  runner.advance(durationTicks);
  return { ...bare, checkpoints: [...runner.checkpoints()] };
}

const launch = (target: string): Action => ({
  type: "technique.launch",
  technique: "T0865",
  target,
});

const busyActions: Recording["actions"] = [
  { t: 30, a: launch("corp-ws") },
  { t: 30, a: { type: "noop" } },
  { t: 120, a: launch("il-1-ctl") },
  { t: 250, a: launch("corp-ws") },
  { t: 431, a: launch("il-1-ctl") },
];

function replay(recording: Recording, chunks: number[]): string {
  const runner = createRunner(
    createWorld(tinyTopology, recording.seed),
    new RecordedSource(recording),
    index,
  );
  for (const n of chunks) runner.advance(n);
  return stateHash(runner.view());
}

describe("recording and replay", () => {
  it("replays a zero-action recording to identical checkpoint hashes", () => {
    const recording = record([], 500);
    expect(recording.checkpoints.map((c) => c.t)).toEqual([100, 200, 300, 400, 500]);
    expect(() => replay(recording, [500])).not.toThrow();
    // Same run twice ends on the same hash.
    expect(replay(recording, [500])).toBe(replay(recording, [500]));
  });

  it("replays placeholder actions to matching checkpoints regardless of chunking", () => {
    const recording = record(busyActions, 600);
    const whole = replay(recording, [600]);
    expect(replay(recording, Array(600).fill(1))).toBe(whole);
    expect(replay(recording, [1, 99, 100, 250, 150])).toBe(whole);
    expect(replay(recording, [7, 593])).toBe(whole);
  });

  it("actually depends on the actions: the recorded hashes differ from the empty run", () => {
    const empty = record([], 600);
    const busy = record(busyActions, 600);
    expect(busy.checkpoints).not.toEqual(empty.checkpoints);
  });

  it("fails loudly when a checkpoint hash does not match", () => {
    const recording = record(busyActions, 300);
    const tampered: Recording = {
      ...recording,
      checkpoints: recording.checkpoints.map((c) => (c.t === 200 ? { ...c, h: "deadbeef" } : c)),
    };
    expect(() => replay(tampered, [300])).toThrow(ReplayMismatchError);
    // Runs that stop before the tampered checkpoint are unaffected.
    expect(() => replay(tampered, [150])).not.toThrow();
  });

  it("fails loudly when the seed or the actions no longer match the recorded hashes", () => {
    const recording = record(busyActions, 600);
    expect(() => replay({ ...recording, seed: SEED + 1 }, [600])).toThrow(ReplayMismatchError);
    // The busy and empty runs have different checkpoints (asserted above), so
    // stripping the actions from a busy recording must be caught.
    expect(() => replay({ ...recording, actions: [] }, [600])).toThrow(ReplayMismatchError);
  });

  it("survives a JSON round-trip of the recording", () => {
    const recording = record(busyActions, 300);
    const revived = JSON.parse(JSON.stringify(recording)) as unknown;
    assertRecording(revived);
    expect(() => replay(revived, [300])).not.toThrow();
  });

  it("RecordedSource returns due actions in recorded order and nothing elsewhere", () => {
    const source = new RecordedSource(bareRecording(busyActions, 500));
    expect(source.due(29)).toEqual([]);
    expect(source.due(30)).toEqual([launch("corp-ws"), { type: "noop" }]);
    expect(source.due(31)).toEqual([]);
  });

  it("assertRecording rejects malformed recordings", () => {
    const good = record([], 100);
    expect(() => assertRecording(good)).not.toThrow();
    expect(() => assertRecording({ ...good, format: "other" })).toThrow();
    expect(() => assertRecording({ ...good, schema: 2 })).toThrow();
    expect(() => assertRecording({ ...good, tickMs: 50 })).toThrow();
    expect(() => assertRecording({ ...good, seed: 1.5 })).toThrow();
    expect(() => assertRecording({ ...good, actions: [{ t: -1, a: { type: "noop" } }] })).toThrow();
    expect(() =>
      assertRecording({ ...good, actions: [{ t: 3, a: { type: "explode" } }] }),
    ).toThrow();
    expect(() => assertRecording({ ...good, checkpoints: [{ t: 100, h: 12 }] })).toThrow();
    expect(() => assertRecording(null)).toThrow();
  });
});

describe("validateContent", () => {
  it("accepts the tiny valid fixture", () => {
    expect(() => validateContent(tinyTopology)).not.toThrow();
  });

  it("rejects a link with a dangling node id and names the problem", () => {
    const broken: Content = {
      ...tinyTopology,
      links: [
        ...tinyTopology.links,
        { id: "l-bad", a: "corp-ws", b: "ghost", protocols: [], latencyTicks: 1 },
      ],
    };
    expect(() => validateContent(broken)).toThrow(ContentError);
    expect(() => validateContent(broken)).toThrow(/ghost/);
  });

  it("rejects dangling zone, conduit and interlocking references", () => {
    const [ws, ...rest] = tinyTopology.nodes;
    if (!ws) throw new Error("fixture has no nodes");
    expect(() =>
      validateContent({ ...tinyTopology, nodes: [{ ...ws, zone: "nowhere" }, ...rest] }),
    ).toThrow(/nowhere/);
    const [link, ...otherLinks] = tinyTopology.links;
    if (!link) throw new Error("fixture has no links");
    expect(() =>
      validateContent({
        ...tinyTopology,
        links: [{ ...link, conduit: "c-missing" }, ...otherLinks],
      }),
    ).toThrow(/c-missing/);
    expect(() => validateContent({ ...tinyTopology, interlockings: [] })).toThrow(/IL-1/);
  });

  it("rejects duplicate ids", () => {
    const [ws] = tinyTopology.nodes;
    if (!ws) throw new Error("fixture has no nodes");
    expect(() => validateContent({ ...tinyTopology, nodes: [...tinyTopology.nodes, ws] })).toThrow(
      /duplicate/,
    );
  });

  it("rejects a node the external pseudo-node cannot reach", () => {
    const island: Content = {
      ...tinyTopology,
      nodes: [
        ...tinyTopology.nodes,
        {
          id: "island",
          kind: "hmi",
          zone: "ctl",
          label: "Island",
          roles: [],
          tags: [],
          hardeningPermille: 0,
        },
      ],
    };
    expect(() => validateContent(island)).toThrow(/unreachable/);
  });

  it("rejects a zone-crossing link whose conduit joins other zones", () => {
    const [first, ...others] = tinyTopology.links;
    if (!first) throw new Error("fixture has no links");
    const wrong: Content = {
      ...tinyTopology,
      links: [{ ...first, conduit: "c-corp-ctl" }, ...others],
    };
    expect(() => validateContent(wrong)).toThrow(/conduit/);
  });
});
