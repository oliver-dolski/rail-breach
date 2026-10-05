// Publication media, made deterministically from the recorded phishing session.
//
// Usage: node scripts/capture.mjs [--frames N] [--verify-determinism] [--reuse-frames] [--cards-only]
//        (npm run media:capture)
//
// A plain run makes the whole set: the 1080p video, the README teaser GIF, the three stills (the
// intro, 00:20 and 00:34) and their README row, the LinkedIn card and the GitHub social preview (the card template is
// scripts/capture/card.html), and then runs the stills gates of scripts/check-stills.mjs.
// --frames N captures only N frames and makes just a clip (a quick check of the pipeline).
// --reuse-frames skips the capture and encodes again from scratch/capture/frames, which is how
// the GIF settings below were tuned without playing the session each time. --cards-only draws just
// the two cards from the stills already in scratch/capture, for working on the template.
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
import { checkStills } from "./check-stills.mjs";
import { createPagesServer, listen } from "./serve-dist.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_DIST = join(ROOT, "scratch", "capture-dist");
const WORK = join(ROOT, "scratch", "capture");
const FRAMES_DIR = join(WORK, "frames");
/** Post drafts and their assets: ignored by git, rebuilt by this script. */
const LINKEDIN = join(ROOT, "_linkedin");
/** The tracked media: the README teaser and its row of stills, outside public/ so Pages never serves them. */
const MEDIA = join(ROOT, "docs", "media");
const TEASER = join(MEDIA, "teaser.gif");

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
/**
 * The master capture runs the intro (introFrames frames, read from the page) and then this many
 * seconds of session clock: the chain lands at about 18 s, the first train halts at about 32 s.
 * The session clock starts when the intro ends.
 */
const CAPTURE_SECONDS = 46;
/** H.264 settings for the video: a visually lossless crf at a slow preset. */
const X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p"];
/** Container flags that keep paths, versions and timestamps out of the files and make them repeatable. */
const REPRODUCIBLE = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"];

// The README teaser. It opens on the first frame of the intro and runs on until the last frame
// that shows the panel clock at the second of the first halt, so the fold, the attack, the signals
// going to stop and a train standing are all in.
/** Index of the first frame of the teaser: the first frame of the capture, which is the intro. */
const GIF_START_FRAME = 0;
/** The panel clock the teaser ends on: the held overview of the first halt. */
const GIF_END_CLOCK = "00:34";
// The intro folds and the camera drifts, so nearly every pixel of every frame changes and a GIF
// of the whole window is heavy: at step 4, 960 px and 256 colours it came to 16.6 MiB against the
// 5 MiB cap. The plan's levers in order (step 5, width 880, 128 then 64 colours, step 8) still left
// 5.55 MiB, so the width went below 880 and the ordered dither was dropped as well (the dither
// noise is what the compressor cannot shrink). Sizes of the 975 frame window (MiB):
// step 4/960/256 16.6, 5/880/256 12.0, 5/880/64 8.2, 8/880/64 5.55, 6/720/64 with dither 5.14,
// 6/720/64 without 4.80. The last is the one used.
/** Every K-th captured frame is kept: 6 is a GIF frame every 240 ms of session time. */
const GIF_STEP = 6;
/** The GIF is scaled to this width (the cap is GIF_MAX_WIDTH). */
const GIF_WIDTH = 720;
/** Display time of each GIF frame in centiseconds; with GIF_STEP it fixes the speed (12 is 8.33 frames a second). */
const GIF_DELAY_CS = 12;
/** Palette size of the GIF. */
const GIF_COLORS = 64;
/** How much faster than real time the teaser plays; the README quotes this value. */
const GIF_SPEED = (GIF_STEP * FRAME_MS) / (GIF_DELAY_CS * 10);
/** No palette dither: the glow gradients band a little, and the file is a third of the size of a dithered one. */
const GIF_DITHER = "none:diff_mode=rectangle";
/** The README teaser may weigh at most this much (it stays in history for good). */
const GIF_MAX_BYTES = 5 * 1024 * 1024;
/** The README teaser may be at most this wide. */
const GIF_MAX_WIDTH = 960;
/**
 * The two clock stills: the attack has landed, and a train stands. Both are named by their clock
 * reading. Each is also shot again with the map labels hidden, and its label boxes written down,
 * for the label legibility gate (G3 in scripts/check-stills.mjs).
 */
const STILLS = [
  { name: "still-attack.png", clock: "00:20" },
  { name: "still-halt.png", clock: "00:34" },
];
/** The still of the intro, half way through it: the levels mid-fall. Located by frame, not by clock. */
const INTRO_STILL = "still-intro.png";
/** The row of stills under the README teaser, left to right: the fold, the attack, the halt. */
const README_STILLS = [INTRO_STILL, "still-attack.png", "still-halt.png"];
/** Width of a README still: three side by side fill the README column, a click opens it larger. */
const README_STILL_WIDTH = 640;
/** A README still stays in history for good, so each one is capped. */
const README_STILL_MAX_BYTES = 400 * 1024;
/** The still the cards show as their picture: the whole board with the full trail and every signal at stop. */
const CARD_STILL = "still-halt.png";
/** The display face, copied next to the card template so the card title uses the same file as the page. */
const CARD_FONT = "space-grotesk-latin-wght-normal.woff2";
/**
 * Time a card page is left alone after it has loaded before it is photographed. A session that
 * is shot sooner sometimes keeps a coarser downscale of the still for good (both states are
 * stable, so comparing two shots does not catch it); after this long every session agrees.
 */
const CARD_SETTLE_MS = 500;
/** The cards: the template is rendered in a window of exactly this size, at a pixel ratio of 1. */
const CARDS = [
  { file: "featured-1200x627.png", width: 1200, height: 627 },
  // GitHub takes a social preview under 1 MB; a PNG over that is written as a JPEG instead.
  { file: "github-social-preview-1280x640.png", width: 1280, height: 640, maxBytes: 1024 * 1024 },
];
/** JPEG quality of the social preview when the PNG is over its limit. */
const PREVIEW_JPEG_QUALITY = 92;
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
  const options = { frames: undefined, verify: false, reuse: false, cardsOnly: false };
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
    } else if (argv[i] === "--cards-only") {
      options.cardsOnly = true;
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
window.__visibility = [];
document.addEventListener("visibilitychange", () => {
  window.__visibility.push(document.visibilityState + " at " + new Date().toISOString());
});
`;

const TWO_FRAMES =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))";

/**
 * The extra shot of a clock still: the same page with the map labels hidden, and where the labels,
 * the map canvas and the pixel ratio were. It happens right after the still's normal screenshot,
 * at the same frame in every session, and the labels are shown again and given two real frames
 * before the next step, so the frames that follow are not touched.
 * Returns { png, info }.
 */
async function labelsHiddenShot(browser) {
  const info = await browser.evaluate(`(() => {
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return {
      dpr: window.devicePixelRatio,
      canvas: box(document.getElementById("map")),
      boxes: [...document.querySelectorAll("#labels .lbl")].map(box).filter((b) => b.w > 0 && b.h > 0),
    };
  })()`);
  await browser.evaluate(`document.getElementById("labels").style.visibility = "hidden"`);
  await browser.evaluate(TWO_FRAMES);
  const png = await browser.screenshot({ fromSurface: true });
  await browser.evaluate(`document.getElementById("labels").style.removeProperty("visibility")`);
  await browser.evaluate(TWO_FRAMES);
  return { png, info };
}

/**
 * Plays the session in a fresh browser profile and screenshots every frame. With `write`, each
 * frame goes to FRAMES_DIR; with `expected`, each frame is only hashed and compared.
 * Returns { introFrames, frames }, one { i, clock, sha } per frame; the frame that first shows
 * a still's clock also carries `shaNoLabels`, the hash of its labels-hidden shot.
 */
async function captureFrames({ origin, count: wanted, write, expected }) {
  const browser = await launchBrowser(WINDOW);
  try {
    for (const domain of ["Network", "Runtime", "Log", "Page"]) {
      await browser.send(`${domain}.enable`);
    }
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
    const introFrames = await browser.evaluate("window.__railBreachCapture.introFrames");
    if (!Number.isInteger(introFrames) || introFrames < 1) {
      throw new Error(`the capture hook reports ${introFrames} intro frames`);
    }
    // A full capture is the intro plus CAPTURE_SECONDS of session clock; --frames N overrides it.
    const count = wanted ?? introFrames + CAPTURE_SECONDS * FPS + 1;
    // Two real animation frames, so the first layout, the canvas size and the labels have settled.
    await browser.evaluate(TWO_FRAMES);

    const frames = [];
    const differing = [];
    const stillsTaken = new Set();
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
      const entry = { i, clock, sha };
      const still = STILLS.find((candidate) => candidate.clock === clock);
      if (still && !stillsTaken.has(clock)) {
        stillsTaken.add(clock);
        const hidden = await labelsHiddenShot(browser);
        entry.shaNoLabels = sha256(hidden.png);
        if (expected && expected[i]?.shaNoLabels !== entry.shaNoLabels) {
          await writeFile(join(WORK, `differs-nolabels-${pad(i)}.png`), hidden.png);
          differing.push(`labels-hidden shot of frame ${i} (clock ${clock})`);
        }
        if (write) {
          const stem = still.name.replace(/\.png$/, "");
          await writeFile(join(WORK, `nolabels-${stem}.png`), hidden.png);
          const boxes = JSON.stringify(hidden.info, null, 1);
          await writeFile(join(WORK, `labels-${stem}.json`), `${boxes}\n`);
        }
      }
      frames.push(entry);
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
    return { introFrames, frames };
  } catch (error) {
    // A page that stops answering has usually been hidden by the desktop (another window over
    // the browser's), so say what it reports; the frame loop cannot go on without animation frames.
    const seen = await browser
      .send(
        "Runtime.evaluate",
        {
          expression: "document.visibilityState + ' ' + JSON.stringify(window.__visibility)",
          returnByValue: true,
        },
        5_000,
      )
      .then(
        (reply) => reply.result.value,
        () => "unreachable",
      );
    error.message += ` (the page reports visibility: ${seen}; now ${new Date().toISOString()})`;
    throw error;
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
async function encodeGif(file, firstFrame, frameCount) {
  await mkdir(dirname(file), { recursive: true });
  const palette = join(WORK, "palette.png");
  const input = [
    "-start_number",
    String(firstFrame),
    "-framerate",
    String(FPS),
    "-t",
    String(frameCount / FPS),
    "-i",
    join(FRAMES_DIR, "%06d.png"),
  ];
  // select keeps frames 0, K, 2K and so on; setpts then spaces the kept frames at the playback rate.
  const pick = `select=not(mod(n\\,${GIF_STEP})),setpts=N/(${100 / GIF_DELAY_CS}*TB),scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await ffmpeg([
    ...input,
    "-vf",
    `${pick},palettegen=stats_mode=diff:max_colors=${GIF_COLORS}`,
    palette,
  ]);
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
    `teaser: ${info.nb_read_frames} frames at ${(100 / GIF_DELAY_CS).toFixed(2)} fps, ${GIF_SPEED}x real speed, ${info.duration.toFixed(2)} s`,
  );
  return failures;
}

/** A screenshot of a card page that has been left alone for CARD_SETTLE_MS and is not changing: two shots 300 ms apart agree. */
async function settledScreenshot(browser) {
  await sleep(CARD_SETTLE_MS);
  let previous = await browser.screenshot({ fromSurface: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(300);
    const next = await browser.screenshot({ fromSurface: true });
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error("the card never stopped changing");
}

/** Width of the side panel in CSS pixels (.app in style.css); the map is the rest of the page. */
const PANEL_CSS_WIDTH = 340;
/** Rows of the still, from the top, that hold the map: everything drawn on it ends above this row. */
const CARD_MAP_ROWS = 940;
/** The ground colour of the map, for the bars when the box has another aspect than the map. */
const CARD_PAD_COLOR = "0x07090d";

/**
 * The map part of the card still (without the side panel), scaled to fit the picture box and
 * padded to its exact size, so the browser shows the file 1:1.
 */
async function cropToBox(file, box) {
  const mapWidth = Math.round((VIEWPORT.width - PANEL_CSS_WIDTH) * DPR);
  await ffmpeg([
    "-i",
    join(WORK, CARD_STILL),
    "-vf",
    `crop=${mapWidth}:${CARD_MAP_ROWS}:0:0,scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${box.w}:${box.h}:(ow-iw)/2:(oh-ih)/2:color=${CARD_PAD_COLOR}`,
    "-frames:v",
    "1",
    file,
  ]);
}

/**
 * Renders the card template once per size, around the captured still, and returns the files
 * written. The page is served from a temporary folder with createPagesServer (base "/"), nothing
 * leaves that origin, and each size is a window of exactly that size, so the screenshot is the card.
 */
async function renderCards() {
  const site = join(WORK, "card-site");
  await rm(site, { recursive: true, force: true });
  await mkdir(site, { recursive: true });
  await copyFile(join(ROOT, "scripts", "capture", "card.html"), join(site, "card.html"));
  await copyFile(join(WORK, CARD_STILL), join(site, CARD_STILL));
  await copyFile(join(ROOT, "src", "assets", "fonts", CARD_FONT), join(site, CARD_FONT));

  const server = createPagesServer({ root: site, base: "/" });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchBrowser({ width: 1400, height: 800 });
  const written = [];
  try {
    for (const domain of ["Network", "Runtime", "Page"]) await browser.send(`${domain}.enable`);
    for (const card of CARDS) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: card.width,
        height: card.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Page.navigate", { url: `${origin}/card.html` });
      for (let waited = 0; ; waited += 100) {
        if (waited > 15_000) throw new Error("the card page never finished loading");
        try {
          const ready = await browser.evaluate(
            `document.readyState === "complete" && document.getElementById("still").complete && innerWidth === ${card.width} && innerHeight === ${card.height}`,
          );
          if (ready) break;
        } catch {
          // the document is still being replaced
        }
        await sleep(100);
      }
      // The picture box has an integer size (the template is in whole pixels). Crop the still to the
      // map and scale it to exactly that size here, with ffmpeg, so the browser draws it 1:1 and
      // never rescales it: its own downscale came out one of several ways from session to session.
      const box = await browser.evaluate(
        `(() => { const b = document.querySelector(".shot"); return { w: b.clientWidth, h: b.clientHeight }; })()`,
      );
      const shot = `shot-${card.width}x${card.height}.png`;
      await cropToBox(join(site, shot), box);
      await browser.evaluate(
        `(() => { const img = document.getElementById("still"); img.src = ${JSON.stringify(shot)}; return img.decode(); })()`,
      );
      await browser.evaluate("document.fonts.ready");
      await browser.evaluate(
        "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
      );
      let file = join(LINKEDIN, card.file);
      let png = await settledScreenshot(browser);
      if (card.maxBytes !== undefined && png.length >= card.maxBytes) {
        console.log(`${card.file} is ${kib(png.length)}, over its limit: writing a JPEG instead`);
        png = await browser.screenshot({
          fromSurface: true,
          format: "jpeg",
          quality: PREVIEW_JPEG_QUALITY,
        });
        file = file.replace(/\.png$/, ".jpg");
      }
      await writeFile(file, png);
      written.push({ file, width: card.width, height: card.height, maxBytes: card.maxBytes });
    }
    const foreign = new Set();
    for (const { method, params } of browser.events) {
      if (method === "Network.requestWillBeSent" && /^https?:/.test(params.request.url)) {
        if (new URL(params.request.url).origin !== origin) foreign.add(params.request.url);
      }
    }
    if (foreign.size > 0) throw new Error(`a card requested ${[...foreign].join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
  return written;
}

/** The first frame whose clock reads the given text. */
function frameAt(frames, clock) {
  const found = frames.find((frame) => frame.clock === clock);
  if (!found) throw new Error(`no captured frame shows the clock ${clock}`);
  return found;
}

/** The last frame whose clock reads the given text. */
function lastFrameAt(frames, clock) {
  const found = frames.findLast((frame) => frame.clock === clock);
  if (!found) throw new Error(`no captured frame shows the clock ${clock}`);
  return found;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const full = options.frames === undefined;

  if (options.cardsOnly) {
    await mkdir(LINKEDIN, { recursive: true });
    const failures = await report(await renderCards());
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return;
  }

  let frames;
  let introFrames;
  if (options.reuse) {
    ({ frames, introFrames } = JSON.parse(await readFile(join(WORK, "frames.json"), "utf8")));
  } else {
    await buildCapture();
    await rm(WORK, { recursive: true, force: true });
    await mkdir(FRAMES_DIR, { recursive: true });

    const server = createPagesServer({ root: CAPTURE_DIST, base: BASE });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    try {
      ({ introFrames, frames } = await captureFrames({
        origin,
        count: options.frames,
        write: true,
      }));
      await writeFile(
        join(WORK, "frames.json"),
        `${JSON.stringify({ fps: FPS, frameMs: FRAME_MS, introFrames, frames }, null, 1)}\n`,
      );
      if (options.verify) {
        await captureFrames({ origin, count: frames.length, write: false, expected: frames });
        console.log(
          `determinism: ${frames.length} frames identical over two sessions (the ${introFrames} intro frames and the labels-hidden shots of the stills included)`,
        );
      }
    } finally {
      server.close();
    }
  }

  if (!full) {
    const clip = join(WORK, "clip.mp4");
    await encodeVideo(clip, frames.length);
    const failures = await report([{ file: clip, width: 1920, height: 1080 }]);
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return;
  }

  await mkdir(LINKEDIN, { recursive: true });
  const video = join(LINKEDIN, "rail-breach-1080p.mp4");
  await encodeVideo(video, frames.length);
  const gifLast = lastFrameAt(frames, GIF_END_CLOCK).i;
  await encodeGif(TEASER, GIF_START_FRAME, gifLast - GIF_START_FRAME + 1);
  const outputs = [
    { file: video, width: 1920, height: 1080, check: () => checkVideo(video) },
    { file: TEASER, check: () => checkGif(TEASER) },
  ];
  const stillFrames = [
    ...STILLS.map(({ name, clock }) => ({ name, index: frameAt(frames, clock).i })),
    { name: INTRO_STILL, index: introFrames / 2 },
  ];
  for (const { name, index } of stillFrames) {
    const target = join(WORK, name);
    await copyFile(join(FRAMES_DIR, `${pad(index)}.png`), target);
    // The stills are also handed over in the post folder, next to the video and the cards.
    await copyFile(target, join(LINKEDIN, name));
    outputs.push({ file: join(LINKEDIN, name), width: 1920, height: 1080 });
  }
  for (const name of README_STILLS) {
    const file = join(MEDIA, name);
    await ffmpeg([
      "-i",
      join(WORK, name),
      "-vf",
      `scale=${README_STILL_WIDTH}:-1:flags=lanczos`,
      ...REPRODUCIBLE,
      file,
    ]);
    outputs.push({
      file,
      width: README_STILL_WIDTH,
      height: (README_STILL_WIDTH * 9) / 16,
      check: async () => {
        const size = (await readFile(file)).length;
        return size > README_STILL_MAX_BYTES
          ? [`${relative(ROOT, file)} is ${size} bytes, over ${README_STILL_MAX_BYTES}`]
          : [];
      },
    });
  }
  for (const card of await renderCards()) {
    outputs.push({
      file: card.file,
      width: card.width,
      height: card.height,
      check: async () => {
        const size = (await readFile(card.file)).length;
        return card.maxBytes !== undefined && size >= card.maxBytes
          ? [`${relative(ROOT, card.file)} is ${size} bytes, over ${card.maxBytes}`]
          : [];
      },
    });
  }
  const failures = await report(outputs);
  if (failures.length > 0) throw new Error(`budget failed:\n${failures.join("\n")}`);

  // G3 and G4: the stills are only good if the labels stay legible and the board is unchanged.
  const stills = await checkStills({ workDir: WORK });
  for (const line of stills.lines) console.log(line);
  if (stills.failures.length > 0)
    throw new Error(`stills gate failed:\n${stills.failures.join("\n")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
