// Publication media, made deterministically from the recorded phishing session.
//
// Usage: node scripts/capture.mjs [--frames N] [--verify-determinism]      (npm run media:capture)
//
// The page is built in capture mode, where the script and not the wall clock advances each frame
// by exactly 40 ms of simulated time. The same recording and the same frame clock give the same
// pixels, so every output below can be rebuilt from this file and the committed recording.
// Reproducibility is promised for the capture host (Windows 11, Edge with a real GPU, ffmpeg on
// PATH), not across machines: another GPU driver or font set can move single pixels.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/** Where the app lives in the capture build, the same subpath as on Pages. */
const BASE = "/rail-breach/";
/** Frames per second of the master capture and of the MP4. */
const FPS = 25;
/** Simulated milliseconds per frame: 1000 / FPS, the value compiled into the capture build. */
const FRAME_MS = 40;
/** Page size in CSS pixels. */
const VIEWPORT = { width: 1600, height: 900 };
/** Device pixel ratio: 1600 x 900 at 1.2 gives frames of exactly 1920 x 1080. */
const DPR = 1.2;
/** The browser window is larger than the viewport so the emulated size always fits on screen. */
const WINDOW = { width: 1700, height: 1100 };
/** The master capture runs this many seconds of session clock: the chain lands at about 18 s, the first train halts at about 32 s. */
const CAPTURE_SECONDS = 46;
/** H.264 settings for the video: a visually lossless crf at a slow preset. */
const X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p"];
/** Container flags that keep paths, versions and timestamps out of the files and make them repeatable. */
const REPRODUCIBLE = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pad = (n) => String(n).padStart(6, "0");

function parseArgs(argv) {
  const options = { frames: undefined, verify: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--frames") {
      options.frames = Number(argv[++i]);
      if (!Number.isInteger(options.frames) || options.frames < 1) {
        throw new Error("--frames needs a whole number of at least 1");
      }
    } else if (argv[i] === "--verify-determinism") {
      options.verify = true;
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
    for (let i = 0; i < count; i++) {
      const clock = await browser.evaluate(
        `(async () => {
          if (!window.__railBreachCapture.frame()) throw new Error("the loop has no frame pending");
          // The compositor needs two real frames to settle form control borders; a screenshot
          // taken sooner differs by a few levels on 212 pixels from one taken later.
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return document.getElementById("clock").innerText.trim();
        })()`,
      );
      const png = await browser.screenshot({ fromSurface: true });
      const sha = sha256(png);
      if (expected && expected[i]?.sha !== sha) {
        // Keep the second image next to the first, so the difference can be looked at.
        await writeFile(join(WORK, `differs-${pad(i)}.png`), png);
        throw new Error(
          `frame ${i} differs between sessions (clock ${clock}): ${expected[i]?.sha} then ${sha}`,
        );
      }
      if (write) await writeFile(join(FRAMES_DIR, `${pad(i)}.png`), png);
      frames.push({ i, clock, sha });
    }

    const facts = await browser.evaluate(
      "({ csp: window.__csp, errors: window.__errors, count: window.__railBreachCapture.frames() })",
    );
    if (facts.count !== count) throw new Error(`the page ran ${facts.count} frames, not ${count}`);
    if (facts.csp.length > 0) throw new Error(`CSP violations: ${facts.csp.join("; ")}`);
    if (facts.errors.length > 0) throw new Error(`page errors: ${facts.errors.join("; ")}`);

    // Nothing may leave the page's own origin, and nothing may fail to load.
    const requested = new Set();
    for (const { method, params } of browser.events) {
      if (method === "Network.requestWillBeSent" && /^https?:/.test(params.request.url)) {
        requested.add(params.request.url);
      }
      if (method === "Runtime.exceptionThrown") {
        throw new Error(
          `exception in the page: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`,
        );
      }
    }
    const foreign = [...requested].filter((url) => new URL(url).origin !== origin);
    if (foreign.length > 0) throw new Error(`requests left the origin: ${foreign.join(", ")}`);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const count = options.frames ?? CAPTURE_SECONDS * FPS + 1;

  await buildCapture();
  await rm(WORK, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });

  const server = createPagesServer({ root: CAPTURE_DIST, base: BASE });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const frames = await captureFrames({ origin, count, write: true });
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

  const clip = join(WORK, "clip.mp4");
  await encodeVideo(clip, count);
  const bytes = await readFile(clip);
  console.log(`${relative(ROOT, clip)} ${(await stat(clip)).size} bytes sha256 ${sha256(bytes)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
