// Machine check of a Rail Breach build or a live URL, from a fresh browser profile with no key.
// Usage: node scripts/smoke.mjs [url]
// Without a URL it serves dist/ under /rail-breach/ the way GitHub Pages does and tests that.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser/cdp.mjs";
import { createPagesServer, listen } from "./serve-dist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BASE = "/rail-breach/";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Recorded before any page script runs, so nothing the page does can be missed.
const RECORDER = `
window.__csp = [];
window.__errors = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__csp.push(e.violatedDirective + " " + e.blockedURI);
});
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
`;

const PAGE_FACTS = `(() => {
  const text = (id) => document.getElementById(id)?.innerText ?? "";
  const map = document.getElementById("map");
  const fallback = document.getElementById("fallback");
  const refs = [
    ...document.querySelectorAll("script[src]"),
    ...document.querySelectorAll('link[rel="stylesheet"][href]'),
    ...document.querySelectorAll('link[rel~="icon"][href]'),
    ...document.querySelectorAll("#fallback img[src]"),
  ].map((el) => ({ kind: el.tagName.toLowerCase(), url: el.src || el.href }));
  return {
    clock: text("clock"),
    signals: text("stat-signals"),
    indicator: text("indicator-label"),
    mapSize: map ? [map.clientWidth, map.clientHeight] : [0, 0],
    fallbackHidden: fallback ? fallback.hidden : null,
    tier: document.documentElement.dataset.renderTier ?? "",
    displayFace: document.fonts.check('600 20px "Space Grotesk"'),
    csp: window.__csp,
    pageErrors: window.__errors,
    session: sessionStorage.length,
    local: localStorage.length,
    refs,
  };
})()`;

const seconds = (clock) => {
  const m = /^(\d+):(\d{2})$/.exec(clock.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

function networkLog(events) {
  const urls = new Map();
  const responses = [];
  const failures = [];
  for (const { method, params } of events) {
    if (method === "Network.requestWillBeSent") urls.set(params.requestId, params.request.url);
    if (method === "Network.responseReceived") {
      responses.push({ url: params.response.url, status: params.response.status });
    }
    if (method === "Network.loadingFailed" && !(params.canceled && !params.blockedReason)) {
      failures.push({
        url: urls.get(params.requestId) ?? params.requestId,
        error: params.errorText,
      });
    }
  }
  const requested = [...urls.values()].filter((url) => /^https?:/.test(url));
  return { requested, responses, failures };
}

async function run(target) {
  const browser = await launchBrowser({ width: 1600, height: 950 });
  try {
    for (const domain of ["Network", "Runtime", "Log", "Page"])
      await browser.send(`${domain}.enable`);
    await browser.send("Page.bringToFront");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    await browser.send("Page.navigate", { url: target });

    const started = Date.now();
    let facts = null;
    while (Date.now() - started < 60_000) {
      await sleep(500);
      try {
        facts = await browser.evaluate(PAGE_FACTS);
      } catch {
        continue; // the document is still being replaced
      }
      if (seconds(facts.clock) >= 20) break;
    }
    if (!facts) throw new Error("the page never answered");
    // Let the last frames land so the stop-state numbers are the settled ones.
    await sleep(500);
    facts = await browser.evaluate(PAGE_FACTS);

    // The panel at a laptop viewport: the first three cards must sit above the fold, with the
    // Try a technique card closed below them.
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    const fold = await browser.evaluate(`(() => {
      const panel = document.getElementById("panel");
      panel.scrollTop = 0;
      const box = (id) => document.getElementById(id)?.getBoundingClientRect();
      const chain = box("card-chain");
      const next = box("card-try");
      return {
        chainBottom: chain ? chain.bottom : -1,
        nextTop: next ? next.top : -1,
        tryOpen: document.getElementById("card-try")?.open === true,
        eventsOpen: document.getElementById("card-events")?.open === true,
        height: window.innerHeight,
      };
    })()`);
    await browser.send("Emulation.clearDeviceMetricsOverride");

    const origin = new URL(target).origin;
    const net = networkLog(browser.events);
    const isFavicon = (url) => new URL(url).pathname === "/favicon.ico";
    const badResponses = net.responses.filter(
      (r) => /^https?:/.test(r.url) && r.status >= 400 && !isFavicon(r.url),
    );
    const failed = net.failures.filter((f) => !/^(data|blob):/.test(f.url) && !isFavicon(f.url));
    const info = [
      ...net.responses
        .filter((r) => r.status >= 400 && isFavicon(r.url))
        .map((r) => `${r.url} ${r.status}`),
      ...net.failures.filter((f) => isFavicon(f.url)).map((f) => `${f.url} ${f.error}`),
    ];

    const consoleErrors = browser.events
      .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
      .map((e) => e.params.args.map((a) => a.value ?? a.description).join(" "));
    const logErrors = browser.events
      .filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
      .filter((e) => !(e.params.entry.url && isFavicon(e.params.entry.url)))
      .map((e) => `${e.params.entry.source}: ${e.params.entry.text} ${e.params.entry.url ?? ""}`);
    const exceptions = browser.events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map(
        (e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text,
      );
    const securityLogs = browser.events
      .filter((e) => e.method === "Log.entryAdded" && e.params.entry.source === "security")
      .map((e) => e.params.entry.text);

    const foreign = net.requested.filter((url) => new URL(url).origin !== origin);
    const signals = /(\d+)\s+of\s+(\d+)/.exec(facts.signals);

    const refs = [];
    for (const ref of facts.refs) {
      let status = net.responses.find((r) => r.url === ref.url)?.status;
      if (status === undefined) {
        status = await browser
          .evaluate(`fetch(${JSON.stringify(ref.url)}).then((r) => r.status)`)
          .catch(() => 0);
      }
      refs.push({ ...ref, status });
    }
    const kinds = new Set(refs.map((r) => r.kind));
    const refsOk =
      refs.every((r) => r.status === 200) &&
      ["script", "link", "img"].every((k) => kinds.has(k)) &&
      refs.filter((r) => r.kind === "link").length >= 2;

    const fontResponses = net.responses
      .filter(
        (r) =>
          r.status === 200 &&
          /^https?:/.test(r.url) &&
          new URL(r.url).origin === origin &&
          new URL(r.url).pathname.endsWith(".woff2"),
      )
      .map((r) => `${r.status} ${r.url}`);

    const checks = [
      [
        "1 no failed or 4xx/5xx request",
        badResponses.length + failed.length === 0,
        [
          ...badResponses.map((r) => `${r.status} ${r.url}`),
          ...failed.map((f) => `${f.error} ${f.url}`),
        ],
      ],
      [
        "2 every request stays on the page origin",
        foreign.length === 0,
        foreign.length ? foreign : [`${net.requested.length} requests, all ${origin}`],
      ],
      [
        "3 no uncaught exception, console error or error log entry",
        exceptions.length + consoleErrors.length + logErrors.length + facts.pageErrors.length === 0,
        [...exceptions, ...consoleErrors, ...logErrors, ...facts.pageErrors],
      ],
      [
        "4 no CSP violation",
        facts.csp.length + securityLogs.length === 0,
        [...facts.csp, ...securityLogs],
      ],
      [
        "5 WebGL2 map live, fallback hidden",
        facts.fallbackHidden === true && facts.mapSize[0] > 0 && facts.mapSize[1] > 0,
        [`map ${facts.mapSize.join("x")}, fallback hidden=${facts.fallbackHidden}`],
      ],
      [
        "6 autoplay reached 00:20 with no input",
        seconds(facts.clock) >= 20,
        [`clock ${facts.clock}`],
      ],
      [
        "7 at least one signal at stop",
        Boolean(signals) && Number(signals[1]) >= 1,
        [`signals ${facts.signals}`],
      ],
      [
        "8 safety invariant HELD",
        facts.indicator.includes("HELD"),
        [`indicator "${facts.indicator}"`],
      ],
      [
        "9 sessionStorage and localStorage empty",
        facts.session === 0 && facts.local === 0,
        [`sessionStorage ${facts.session}, localStorage ${facts.local}`],
      ],
      [
        "10 script, stylesheet, icon and fallback image answered 200",
        refsOk,
        refs.map((r) => `${r.status} ${r.kind} ${r.url}`),
      ],
      [
        "11 render tier reported",
        facts.fallbackHidden === true && ["high", "standard", "lite"].includes(facts.tier),
        [`tier ${facts.tier || "none"}`],
      ],
      [
        "12 display face loaded from the page origin",
        facts.displayFace === true && fontResponses.length >= 1,
        [
          `document.fonts.check ${facts.displayFace}`,
          ...(fontResponses.length
            ? fontResponses
            : ["no .woff2 answered 200 from the page origin"]),
        ],
      ],
      [
        "13 four cards above the fold at 1280 x 720",
        fold.chainBottom > 0 &&
          fold.chainBottom <= fold.height &&
          fold.nextTop >= fold.chainBottom &&
          !fold.tryOpen &&
          fold.eventsOpen,
        [
          `attack chain card ends at ${Math.round(fold.chainBottom)} of ${fold.height}, next card starts at ${Math.round(fold.nextTop)}`,
        ],
      ],
    ];

    let failures = 0;
    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
      if (!ok || detail.length <= 2)
        for (const line of new Set(detail)) console.log(`     ${line}`);
      if (!ok) failures++;
    }
    for (const line of info)
      console.log(`INFO ${line} (browser asked for the root icon; Pages answers 404 too)`);

    const host = new URL(target).hostname;
    const out = join(ROOT, "scratch");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `smoke-${host}.png`), await browser.screenshot());
    await writeFile(
      join(out, `smoke-${host}.json`),
      `${JSON.stringify(
        {
          target,
          requests: net.requested.length,
          clock: facts.clock,
          signals: facts.signals,
          indicator: facts.indicator,
          passed: checks.length - failures,
          failed: failures,
          checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
          info,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `${failures === 0 ? "smoke ok" : `smoke FAILED (${failures})`}: ${net.requested.length} requests, clock ${facts.clock}, signals ${facts.signals}, tier ${facts.tier}`,
    );
    return failures === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

const arg = process.argv[2];
if (arg) {
  process.exitCode = await run(arg);
} else if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/index.html is missing: run npm run build first");
  process.exitCode = 2;
} else {
  const server = createPagesServer({ root: DIST, base: BASE });
  try {
    const port = await listen(server);
    process.exitCode = await run(`http://127.0.0.1:${port}${BASE}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
