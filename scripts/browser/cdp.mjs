// Minimal Chrome DevTools Protocol driver for Edge or Chrome, Node built-ins only.
// The window is headed on purpose: the map needs the real GPU, and a headless browser falls
// back to a software WebGL2 that is slow enough to change what the simulation shows.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

/**
 * Start a fresh browser profile and attach to its first page.
 * @param {{ width?: number, height?: number }} [size]
 */
export async function launchBrowser({ width = 1600, height = 950 } = {}) {
  const exe = browserPath();
  const profile = await mkdtemp(join(tmpdir(), "rail-breach-browser-"));
  const child = spawn(
    exe,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
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
    await rm(profile, { recursive: true, force: true }).catch(() => {});
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

  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++next;
      pending.set(id, { done, fail });
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
    // Edge releases profile files late, so a few retries before giving up.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await rm(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(500);
      }
    }
    console.warn(`left behind the temporary browser profile ${profile}`);
  }

  return { send, evaluate, events, screenshot, close };
}
