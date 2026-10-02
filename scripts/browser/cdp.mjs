// Minimal Chrome DevTools Protocol driver for Edge or Chrome, Node built-ins only.
// The browser runs headless (--headless=new) by default, so no window ever opens on the owner's
// desktop. New headless keeps the real GPU through ANGLE/D3D11; set RAIL_BREACH_HEADED=1 to get a
// visible window when a human wants to watch.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// One profile directory kept across runs, never a new one per run. On the first start of a
// profile Edge checks whether the Windows account has a blank password by trying to log on
// with an empty one, and keeps the answer in the profile. A new profile on every run turned
// each start into a failed logon (event 4625), and ten of them lock the owner's account.
// Kept, the profile fails that check at most once per password change.
const PROFILE = join(process.env.LOCALAPPDATA ?? tmpdir(), "rail-breach", "browser-profile");
// The site data lives in the Default subfolder: removed before each start, so every run still
// begins with empty storage and an empty cache, as captures and smoke runs expect.
const SITE_DATA = join(PROFILE, "Default");

function browserPath() {
  const fromEnv = process.env.RAIL_BREACH_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(EDGE)) return EDGE;
  console.error(
    `No browser found. Set RAIL_BREACH_BROWSER to an Edge or Chrome executable (looked for ${fromEnv ?? EDGE}).`,
  );
  process.exit(2);
}

async function debuggingPort(profile, child) {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error("the browser exited before it opened a debugging port");
    try {
      const first = (await readFile(file, "utf8")).split("\n")[0].trim();
      if (first) return Number(first);
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error("the browser did not write DevToolsActivePort in 10 s");
}

async function pageTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // the endpoint is not up yet
    }
    await sleep(100);
  }
  throw new Error("no page target appeared");
}

async function removeSiteData() {
  // Edge releases profile files late, so a few retries before giving up.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(SITE_DATA, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(
    `could not clear the browser site data in ${SITE_DATA}; is a test browser still running?`,
  );
}

/**
 * Start the browser on the kept profile with its site data cleared, and attach to its first page.
 * @param {{ width?: number, height?: number }} [size]
 */
export async function launchBrowser({ width = 1600, height = 950 } = {}) {
  const exe = browserPath();
  const profile = PROFILE;
  await mkdir(profile, { recursive: true });
  await rm(join(profile, "DevToolsActivePort"), { force: true });
  await removeSiteData();
  const child = spawn(
    exe,
    [
      "--remote-debugging-port=0",
      ...(process.env.RAIL_BREACH_HEADED === "1" ? [] : ["--headless=new"]),
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // A new profile in Edge signs in with the Windows account on its own, syncs the owner's
      // extensions and opens their welcome pages and a sync dialog as tabs of the same window.
      // The page under test then stops being the visible tab: document.visibilityState turns
      // "hidden" and requestAnimationFrame stops, which hung long captures at random. A bare
      // browser has no account, no extension and no extra tab.
      "--disable-sync",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      `--window-size=${width},${height}`,
      "--window-position=0,0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((done) => child.once("exit", done));

  let socket;
  let next = 0;
  const pending = new Map();
  const events = [];
  try {
    const port = await debuggingPort(profile, child);
    socket = new WebSocket(await pageTarget(port));
    await new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => fail(new Error("CDP socket failed")), { once: true });
    });
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && pending.has(data.id)) {
      const { done, fail } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) fail(new Error(`${data.error.message} (${data.error.code})`));
      else done(data.result);
    } else if (data.method) {
      events.push(data);
    }
  });

  // A call that never answers would hang a run that has no one watching it, so each one has a
  // limit: far above the slowest real call (a 1080p screenshot takes under a second), well
  // below anything a person would wait for.
  const send = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((done, fail) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method} got no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  async function evaluate(expression) {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) {
      const { exception, text } = reply.exceptionDetails;
      throw new Error(exception?.description ?? text);
    }
    return reply.result.value;
  }

  async function screenshot(params = {}) {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...params });
    return Buffer.from(data, "base64");
  }

  async function close() {
    try {
      await send("Browser.close");
    } catch {
      // the socket closes with the browser
    }
    const timeout = sleep(10_000).then(() => "timeout");
    if ((await Promise.race([exited, timeout])) === "timeout") child.kill();
    await exited;
  }

  return { send, evaluate, events, screenshot, close };
}
