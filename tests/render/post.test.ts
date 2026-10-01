import { describe, expect, it } from "vitest";
import {
  bloomSettings,
  chooseTier,
  EMISSIVE_MAX,
  EMISSIVE_PER_GLOW,
  emissiveGain,
  type FloatProbe,
  FrameGovernor,
  firstWorking,
  GOVERNOR_LIMIT_MS,
  GOVERNOR_WINDOW,
  TONE_KNEE,
  toneShoulder,
  VIGNETTE_DEPTH,
} from "../../src/render/gl/tier";

interface StubOptions {
  extensions: readonly string[];
  status: number;
}

const COMPLETE = 0x8cd5;
const INCOMPLETE = 0x8cd6;

/** A context that answers only what tier detection asks, and counts what it hands out and takes back. */
function stubProbe(options: StubOptions) {
  const live = { textures: 0, framebuffers: 0 };
  const probe: FloatProbe = {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    RGBA16F: 0x881a,
    HALF_FLOAT: 0x140b,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: COMPLETE,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    NEAREST: 0x2600,
    getExtension: (name) => (options.extensions.includes(name) ? {} : null),
    createTexture: () => {
      live.textures++;
      return {} as WebGLTexture;
    },
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    createFramebuffer: () => {
      live.framebuffers++;
      return {} as WebGLFramebuffer;
    },
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => options.status,
    deleteFramebuffer: () => {
      live.framebuffers--;
    },
    deleteTexture: () => {
      live.textures--;
    },
  };
  return { probe, live };
}

describe("emissive gain", () => {
  it("follows 1 + min(0.06 g, 0.6) from the glow radius", () => {
    expect(emissiveGain(8)).toBeCloseTo(1.48, 9);
    expect(emissiveGain(9)).toBeCloseTo(1.54, 9);
    expect(emissiveGain(6)).toBeCloseTo(1.36, 9);
    expect(emissiveGain(14)).toBeCloseTo(1.6, 9);
    expect(emissiveGain(0)).toBe(1);
    expect(emissiveGain(20)).toBeCloseTo(1.6, 9);
    expect(EMISSIVE_PER_GLOW).toBe(0.06);
    expect(EMISSIVE_MAX).toBe(0.6);
  });
});

describe("tone shoulder", () => {
  it("is the identity up to 0.80", () => {
    for (let i = 0; i <= 80; i++) {
      const c = i / 100;
      expect(toneShoulder(c), `c = ${c}`).toBe(c);
    }
  });

  it("rises strictly above the knee, is continuous at it, and stays below white", () => {
    expect(TONE_KNEE).toBe(0.8);
    expect(toneShoulder(0.8 + 1e-9)).toBeCloseTo(0.8, 6);
    let previous = toneShoulder(0.8);
    for (let c = 0.81; c <= 3; c += 0.01) {
      const v = toneShoulder(c);
      expect(v, `c = ${c}`).toBeGreaterThan(previous);
      expect(v).toBeLessThan(1);
      previous = v;
    }
    // Far out the double saturates at exactly 1, which is white and never beyond it.
    for (const c of [5, 8, 10]) expect(toneShoulder(c)).toBeLessThanOrEqual(1);
  });
});

describe("bloom settings", () => {
  it("high: three float levels, bright pass above SDR white, weights summing near 1", () => {
    const s = bloomSettings("high", false);
    expect(s.levels).toBe(3);
    expect(s.float).toBe(true);
    expect(s.threshold).toEqual([0.8, 1.2]);
    expect(s.weights).toEqual([0.45, 0.35, 0.3]);
    expect(s.strength).toBe(0.9);
    expect(bloomSettings("high", true).strength).toBe(0.5);
    expect(VIGNETTE_DEPTH).toBe(0.28);
  });

  it("standard: today's look, two RGBA8 levels, the old bright pass", () => {
    const s = bloomSettings("standard", false);
    expect(s.levels).toBe(2);
    expect(s.float).toBe(false);
    expect(s.threshold).toEqual([0.6, 1.0]);
    expect(s.strength).toBe(0.8);
    expect(bloomSettings("standard", true).strength).toBe(0.5);
  });

  it("lite: no bloom chain whatever the motion preference", () => {
    expect(bloomSettings("lite", false).levels).toBe(0);
    expect(bloomSettings("lite", true).levels).toBe(0);
  });
});

describe("tier choice", () => {
  it("is high with EXT_color_buffer_float and a complete framebuffer", () => {
    const { probe, live } = stubProbe({ extensions: ["EXT_color_buffer_float"], status: COMPLETE });
    expect(chooseTier(probe)).toBe("high");
    expect(live).toEqual({ textures: 0, framebuffers: 0 });
  });

  it("is high with only EXT_color_buffer_half_float and a complete framebuffer", () => {
    const { probe, live } = stubProbe({
      extensions: ["EXT_color_buffer_half_float"],
      status: COMPLETE,
    });
    expect(chooseTier(probe)).toBe("high");
    expect(live).toEqual({ textures: 0, framebuffers: 0 });
  });

  it("is standard without either extension", () => {
    const { probe, live } = stubProbe({ extensions: [], status: COMPLETE });
    expect(chooseTier(probe)).toBe("standard");
    expect(live).toEqual({ textures: 0, framebuffers: 0 });
  });

  it("is standard when the extension is offered but the framebuffer is incomplete (G12)", () => {
    const { probe, live } = stubProbe({
      extensions: ["EXT_color_buffer_float"],
      status: INCOMPLETE,
    });
    expect(chooseTier(probe)).toBe("standard");
    expect(live).toEqual({ textures: 0, framebuffers: 0 });
  });
});

describe("falling through the tiers", () => {
  it("takes the first tier whose build does not throw, with its value", () => {
    const ok = firstWorking(["high", "standard", "lite"], (tier) => `built ${tier}`);
    expect(ok).toEqual({ tier: "high", value: "built high" });
  });

  it("drops from high to standard when high throws", () => {
    const tried: string[] = [];
    const got = firstWorking(["high", "standard", "lite"], (tier) => {
      tried.push(tier);
      if (tier === "high") throw new Error("incomplete framebuffer");
      return tier.length;
    });
    expect(got).toEqual({ tier: "standard", value: 8 });
    expect(tried).toEqual(["high", "standard"]);
  });

  it("rethrows the last error when every tier fails, so the still can take over", () => {
    expect(() =>
      firstWorking(["high", "standard", "lite"], (tier) => {
        throw new Error(`no ${tier}`);
      }),
    ).toThrow("no lite");
  });
});

describe("the frame-time governor", () => {
  /** Feeds the same delta `count` times and returns the calls that tripped. */
  function feedAll(governor: FrameGovernor, deltas: readonly number[]): number[] {
    const tripped: number[] = [];
    deltas.forEach((dt, i) => {
      if (governor.feed(dt)) tripped.push(i + 1);
    });
    return tripped;
  }

  it("trips on exactly the call that fills the window with a median of 29 ms", () => {
    expect(GOVERNOR_WINDOW).toBe(90);
    expect(GOVERNOR_LIMIT_MS).toBe(28);
    const governor = new FrameGovernor(true);
    expect(feedAll(governor, new Array(90).fill(29))).toEqual([90]);
  });

  it("does not trip at a median of 27 ms", () => {
    expect(feedAll(new FrameGovernor(true), new Array(400).fill(27))).toEqual([]);
  });

  it("looks at the median, so a few long frames among fast ones change nothing", () => {
    const deltas = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 250 : 16));
    expect(feedAll(new FrameGovernor(true), deltas)).toEqual([]);
  });

  it("never trips with fewer than 90 deltas", () => {
    expect(feedAll(new FrameGovernor(true), new Array(89).fill(100))).toEqual([]);
  });

  it("stays tripped and reports the switch only once", () => {
    const governor = new FrameGovernor(true);
    expect(feedAll(governor, new Array(300).fill(40))).toEqual([90]);
  });

  it("is switched off in the capture build: whatever it is fed, it never trips", () => {
    expect(feedAll(new FrameGovernor(false), new Array(500).fill(500))).toEqual([]);
  });

  it("does not count a frame with no delta (the first one, or the first after a resume)", () => {
    const governor = new FrameGovernor(true);
    expect(feedAll(governor, [0, ...new Array(89).fill(29)])).toEqual([]);
    expect(governor.feed(29)).toBe(true);
  });
});
