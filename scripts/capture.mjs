// Publication media, made deterministically from the recorded phishing session.
//
// Usage: node scripts/capture.mjs [--frames N] [--verify-determinism] [--reuse-frames]
//        (npm run media:capture)
//
// A plain run makes the whole set: the 1080p video, the README teaser GIF and the two stills.
// --frames N captures only N frames and makes just a clip (a quick check of the pipeline).
// --reuse-frames skips the capture and encodes again from scratch/capture/frames, which is how
// the GIF settings below were tuned without playing the session each time.
//
// The page is built in capture mode, where the script and not the wall clock advances each frame
// by exactly 40 ms of simulated time. The same recording and the same frame clock give the same
// pixels, so every output below can be rebuilt from this file and the committed recording.
// Reproducibility is promised for the capture host (Windows 11, Edge with a real GPU, ffmpeg on
// PATH), not across machines: another GPU driver or font set can move single pixels.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { launchBrowser } from "./browser/cdp.mjs";
import { createPagesServer, listen } from "./serve-dist.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_DIST = join(ROOT, "scratch", "capture-dist");
const WORK = join(ROOT, "scratch", "capture");
const FRAMES_DIR = join(WORK, "frames");
/** Post drafts and their assets: ignored by git, rebuilt by this script. */
const LINKEDIN = join(ROOT, "_linkedin");
/** The only media file that is tracked: the README teaser, outside public/ so Pages never serves it. */
const TEASER = join(ROOT, "docs", "media", "teaser.gif");

/** Where the app lives in the capture build, the same subpath as on Pages. */
const BASE = "/rail-breach/";
/** Frames per second of the master capture and of the MP4. */
const FPS = 25;
/** Simulated milliseconds per frame: 1000 / FPS, the value compiled into the capture build. */
const FRAME_MS = 40;
/**
 * Page size in CSS pixels and device pixel ratio: 1280 x 720 at 1.5 gives frames of exactly
 * 1920 x 1080. The size is a determinism choice, not a taste: at 1600 x 900 (ratio 1.2) and at
 * 1920 x 1080 (ratio 1) the browser re-draws the side panel's control borders in one of two
 * ways, at random, from one screenshot to the next, so about one frame in five differed between
 * two sessions. At 1280 x 720 and 1440 x 810 no screenshot in 600 and 200 changed.
 */
const VIEWPORT = { width: 1280, height: 720 };
const DPR = 1.5;
/** The browser window is larger than the viewport so the emulated size always fits on screen. */
const WINDOW = { width: 1700, height: 1100 };
/** The master capture runs this many seconds of session clock: the chain lands at about 18 s, the first train halts at about 32 s. */
const CAPTURE_SECONDS = 46;
/** H.264 settings for the video: a visually lossless crf at a slow preset. */
const X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p"];
/** Container flags that keep paths, versions and timestamps out of the files and make them repeatable. */
const REPRODUCIBLE = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"];

// The README teaser. The window starts a few seconds before the chain lands and ends after the
// first train has stopped, so the attack, the signals going to stop and a train standing are all in.
/** Session clock, in seconds, of the first frame of the teaser. */
const GIF_START_S = 6;
/** Session clock, in seconds, where the teaser ends (the first train halts at about 32 s). */
const GIF_END_S = 38;
/** Every K-th captured frame is kept: 4 is a GIF frame every 160 ms of session time. */
const GIF_STEP = 4;
/** The GIF is scaled to this width; 960 is the largest the plan allows and fits the README column. */
const GIF_WIDTH = 960;
/** Display time of each GIF frame in centiseconds (8 is 12.5 frames a second). */
const GIF_DELAY_CS = 8;
/** How much faster than real time the teaser plays; the README quotes this value. */
const GIF_SPEED = (GIF_STEP * FRAME_MS) / (GIF_DELAY_CS * 10);
/** Palette dither: a fixed ordered pattern, so the file is the same on every run and flat areas do not crawl. */
const GIF_DITHER = "bayer:bayer_scale=5:diff_mode=rectangle";
/** The README teaser may weigh at most this much (it stays in history for good). */
const GIF_MAX_BYTES = 5 * 1024 * 1024;
/** The README teaser may be at most this wide. */
const GIF_MAX_WIDTH = 960;
/** The two stills: the attack has landed, and a train stands. Both are named by their clock reading. */
const STILLS = [
  { name: "still-attack.png", clock: "00:20" },
  { name: "still-halt.png", clock: "00:34" },
];
/** LinkedIn video limits, checked 2026-10-01 (plan 03-04): 3 s to 15 min, 75 KB to 5 GB. */
const VIDEO_LIMITS = {
  minSeconds: 3,
  maxSeconds: 15 * 60,
  minBytes: 75 * 1024,
  maxBytes: 5 * 1024 ** 3,
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pad = (n) => String(n).padStart(6, "0");

function parseArgs(argv) {
  const options = { frames: undefined, verify: false, reuse: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--frames") {
      options.frames = Number(argv[++i]);
      if (!Number.isInteger(options.frames) || options.frames < 1) {
        throw new Error("--frames needs a whole number of at least 1");
      }
    } else if (argv[i] === "--verify-determinism") {
      options.verify = true;
    } else if (argv[i] === "--reuse-frames") {
      options.reuse = true;
    } else {
      throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return options;
}

/** Builds the app in capture mode, the only build that contains the frame clock. */
async function buildCapture() {
  await build({
    root: ROOT,
    mode: "capture",
    logLevel: "warn",
    build: { outDir: CAPTURE_DIST, emptyOutDir: true },
  });
}

// Recorded before any page script runs, so a violation or an error cannot slip past unseen.
const RECORDER = `
window.__csp = [];
window.__errors = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
`;

/**
 * Plays the session in a fresh browser profile and screenshots every frame. With `write`, each
 * frame goes to FRAMES_DIR; with `expected`, each frame is only hashed and compared.
 * Returns one { i, clock, sha } per frame.
 */
async function captureFrames({ origin, count, write, expected }) {
  const browser = await launchBrowser(WINDOW);
  try {
    for (const domain of ["Network", "Runtime", "Log", "Page"]) {
      await browser.send(`${domain}.enable`);
    }
    await browser.send("Page.bringToFront");
    await browser.send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: DPR,
      mobile: false,
    });
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    await browser.send("Page.navigate", { url: `${origin}${BASE}` });

    for (let waited = 0; ; waited += 100) {
      if (waited > 30_000) throw new Error("the capture build never installed its frame hook");
      try {
        if (await browser.evaluate("typeof window.__railBreachCapture === 'object'")) break;
      } catch {
        // the document is still being replaced
      }
      await sleep(100);
    }
    await browser.evaluate("window.__railBreachCapture.ready");
    // Two real animation frames, so the first layout, the canvas size and the labels have settled.
    await browser.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    const frames = [];
    const differing = [];
    for (let i = 0; i < count; i++) {
      const clock = await browser.evaluate(
        `(async () => {
          if (!window.__railBreachCapture.frame()) throw new Error("the loop has no frame pending");
          // Two real frames, so the compositor has drawn what this step changed before the shot.
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return document.getElementById("clock").innerText.trim();
        })()`,
      );
      const png = await browser.screenshot({ fromSurface: true });
      const sha = sha256(png);
      if (expected && expected[i]?.sha !== sha) {
        // Keep the second image next to the first, so the difference can be looked at.
        await writeFile(join(WORK, `differs-${pad(i)}.png`), png);
        differing.push(`frame ${i} (clock ${clock})`);
      }
      if (write) await writeFile(join(FRAMES_DIR, `${pad(i)}.png`), png);
      frames.push({ i, clock, sha });
    }

    if (differing.length > 0) {
      throw new Error(
        `${differing.length} frames differ between sessions: ${differing.join(", ")}`,
      );
    }

    const facts = await browser.evaluate(
      "({ csp: window.__csp, errors: window.__errors, count: window.__railBreachCapture.frames() })",
    );
    if (facts.count !== count) throw new Error(`the page ran ${facts.count} frames, not ${count}`);
    if (facts.csp.length > 0) throw new Error(`CSP violations: ${facts.csp.join("; ")}`);
    if (facts.errors.length > 0) throw new Error(`page errors: ${facts.errors.join("; ")}`);

    // Nothing may leave the page's own origin, and nothing but the favicon may fail to load.
    const requested = new Set();
    const broken = [];
    for (const { method, params } of browser.events) {
      if (method === "Network.requestWillBeSent" && /^https?:/.test(params.request.url)) {
        requested.add(params.request.url);
      }
      if (method === "Network.responseReceived" && params.response.status >= 400) {
        if (new URL(params.response.url).pathname !== "/favicon.ico") {
          broken.push(`${params.response.status} ${params.response.url}`);
        }
      }
      if (method === "Runtime.exceptionThrown") {
        throw new Error(
          `exception in the page: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`,
        );
      }
    }
    const foreign = [...requested].filter((url) => new URL(url).origin !== origin);
    if (foreign.length > 0) throw new Error(`requests left the origin: ${foreign.join(", ")}`);
    if (broken.length > 0) throw new Error(`requests failed: ${broken.join(", ")}`);
    return frames;
  } finally {
    await browser.close();
  }
}

/** Runs ffmpeg quietly and fails with its own message. */
async function ffmpeg(args) {
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      maxBuffer: 1 << 26,
    });
  } catch (error) {
    throw new Error(`ffmpeg failed: ${error.stderr || error.message}`);
  }
}

/** The video of every captured frame. */
async function encodeVideo(file, count) {
  await mkdir(dirname(file), { recursive: true });
  await ffmpeg([
    "-framerate",
    String(FPS),
    "-i",
    join(FRAMES_DIR, "%06d.png"),
    "-frames:v",
    String(count),
    ...X264,
    "-movflags",
    "+faststart",
    ...REPRODUCIBLE,
    "-r",
    String(FPS),
    file,
  ]);
}

/**
 * The README teaser from the frames of the window, every GIF_STEP-th one. Two passes: the palette
 * is built from all the frames at once (only the pixels that change count, so the moving signals
 * and particles get colours), then every frame is mapped onto that palette.
 */
async function encodeGif(file) {
  await mkdir(dirname(file), { recursive: true });
  const palette = join(WORK, "palette.png");
  const input = [
    "-start_number",
    String(GIF_START_S * FPS),
    "-framerate",
    String(FPS),
    "-t",
    String(GIF_END_S - GIF_START_S),
    "-i",
    join(FRAMES_DIR, "%06d.png"),
  ];
  // select keeps frames 0, K, 2K and so on; setpts then spaces the kept frames at the playback rate.
  const pick = `select=not(mod(n\\,${GIF_STEP})),setpts=N/(${100 / GIF_DELAY_CS}*TB),scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await ffmpeg([...input, "-vf", `${pick},palettegen=stats_mode=diff`, palette]);
  await ffmpeg([
    ...input,
    "-i",
    palette,
    "-lavfi",
    `${pick}[x];[x][1:v]paletteuse=dither=${GIF_DITHER}`,
    ...REPRODUCIBLE,
    "-fps_mode",
    "passthrough",
    "-loop",
    "0",
    file,
  ]);
}

/** Width and height of a PNG, read from its header. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,pix_fmt,nb_read_frames:format=duration,size",
    "-of",
    "json",
    file,
  ]);
  const info = JSON.parse(stdout);
  return {
    ...info.streams[0],
    duration: Number(info.format.duration),
    size: Number(info.format.size),
  };
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

/**
 * One line per output: path, size, dimensions, SHA-256, and the output's own check.
 * Returns the failed budgets.
 */
async function report(outputs) {
  const failures = [];
  for (const { file, width, height, check } of outputs) {
    const bytes = await readFile(file);
    const dims = file.endsWith(".png") ? pngSize(bytes) : await probe(file);
    const label = relative(ROOT, file).replaceAll("\\", "/");
    console.log(
      `${label}  ${kib(bytes.length)}  ${dims.width}x${dims.height}  sha256 ${sha256(bytes)}`,
    );
    if (width !== undefined && (dims.width !== width || dims.height !== height)) {
      failures.push(`${label} is ${dims.width}x${dims.height}, wanted ${width}x${height}`);
    }
    if (check) failures.push(...(await check()));
  }
  return failures;
}

/** The MP4 against what LinkedIn accepts and what the plan promised. */
async function checkVideo(file) {
  const info = await probe(file);
  const failures = [];
  if (info.codec_name !== "h264") failures.push(`video codec is ${info.codec_name}`);
  if (info.pix_fmt !== "yuv420p") failures.push(`video pixel format is ${info.pix_fmt}`);
  if (info.r_frame_rate !== `${FPS}/1`) failures.push(`video frame rate is ${info.r_frame_rate}`);
  if (info.duration < VIDEO_LIMITS.minSeconds || info.duration > VIDEO_LIMITS.maxSeconds) {
    failures.push(`video lasts ${info.duration} s`);
  }
  if (info.size < VIDEO_LIMITS.minBytes || info.size > VIDEO_LIMITS.maxBytes) {
    failures.push(`video is ${info.size} bytes`);
  }
  console.log(
    `video: ${info.codec_name} ${info.pix_fmt} ${info.r_frame_rate} fps, ${info.nb_read_frames} frames, ${info.duration.toFixed(2)} s`,
  );
  return failures;
}

/** The teaser against its budget and the width the README column can use. */
async function checkGif(file) {
  const info = await probe(file);
  const failures = [];
  if (info.size > GIF_MAX_BYTES) {
    failures.push(`teaser is ${info.size} bytes, over ${GIF_MAX_BYTES}`);
  }
  if (info.width > GIF_MAX_WIDTH) {
    failures.push(`teaser is ${info.width} px wide, over ${GIF_MAX_WIDTH}`);
  }
  console.log(
    `teaser: ${info.nb_read_frames} frames at ${100 / GIF_DELAY_CS} fps, ${GIF_SPEED}x real speed, ${info.duration.toFixed(2)} s`,
  );
  return failures;
}

/** The first frame whose clock reads the given text. */
function frameAt(frames, clock) {
  const found = frames.find((frame) => frame.clock === clock);
  if (!found) throw new Error(`no captured frame shows the clock ${clock}`);
  return found;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const count = options.frames ?? CAPTURE_SECONDS * FPS + 1;
  const full = options.frames === undefined;

  let frames;
  if (options.reuse) {
    frames = JSON.parse(await readFile(join(WORK, "frames.json"), "utf8")).frames;
  } else {
    await buildCapture();
    await rm(WORK, { recursive: true, force: true });
    await mkdir(FRAMES_DIR, { recursive: true });

    const server = createPagesServer({ root: CAPTURE_DIST, base: BASE });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    try {
      frames = await captureFrames({ origin, count, write: true });
      await writeFile(
        join(WORK, "frames.json"),
        `${JSON.stringify({ fps: FPS, frameMs: FRAME_MS, frames }, null, 1)}\n`,
      );
      if (options.verify) {
        await captureFrames({ origin, count, write: false, expected: frames });
        console.log(`determinism: ${count} frames identical over two sessions`);
      }
    } finally {
      server.close();
    }
  }

  if (!full) {
    const clip = join(WORK, "clip.mp4");
    await encodeVideo(clip, count);
    const failures = await report([{ file: clip, width: 1920, height: 1080 }]);
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return;
  }

  await mkdir(LINKEDIN, { recursive: true });
  const video = join(LINKEDIN, "rail-breach-1080p.mp4");
  await encodeVideo(video, count);
  await encodeGif(TEASER);
  const outputs = [
    { file: video, width: 1920, height: 1080, check: () => checkVideo(video) },
    { file: TEASER, check: () => checkGif(TEASER) },
  ];
  for (const { name, clock } of STILLS) {
    const target = join(WORK, name);
    await copyFile(join(FRAMES_DIR, `${pad(frameAt(frames, clock).i)}.png`), target);
    outputs.push({ file: target, width: 1920, height: 1080 });
  }
  const failures = await report(outputs);
  if (failures.length > 0) throw new Error(`budget failed:\n${failures.join("\n")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
