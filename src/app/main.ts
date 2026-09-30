import "../ui/style.css";
import { layout } from "../content/layout";
import { network } from "../content/network";
import { techniques } from "../content/techniques";
import recordingJson from "../recordings/phishing-dispatcher.json";
import { detectWebgl2, fitCanvas, watchContext } from "../render/gl/context";
import { ALERT_COLORS, cssColor, SIGNAL_COLORS } from "../render/palette";
import { ParticleRing, packetParticles } from "../render/particleRing";
import { MapRenderer } from "../render/renderer";
import { buildView, createViewContext } from "../render/view";
import { setText } from "../ui/dom";
import { showFallback } from "../ui/fallback";
import { createLabels } from "../ui/labels";
import { createNames, EventLog } from "../ui/panel/log";
import { createPanel } from "../ui/panel/panel";
import { type LoopHandle, startLoop } from "./loop";
import { createAttractSession } from "./session";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

/** The panel shares the map's palette: one source for every signal and alert colour. */
function applyPalette(root: HTMLElement): void {
  const set = (name: string, value: string): void => root.style.setProperty(name, value);
  set("--signal-stop", cssColor(SIGNAL_COLORS.stop));
  set("--signal-caution", cssColor(SIGNAL_COLORS.caution));
  set("--signal-proceed", cssColor(SIGNAL_COLORS.proceed));
  set("--attacker", cssColor(ALERT_COLORS.attacker));
  set("--impact", cssColor(ALERT_COLORS.impact));
  set("--degraded", cssColor(ALERT_COLORS.degraded));
  set("--detection", cssColor(ALERT_COLORS.detection));
}

function boot(): void {
  applyPalette(document.documentElement);
  const canvas = byId<HTMLCanvasElement>("map");

  // Attract mode: the committed recording starts playing with no user action.
  let session: ReturnType<typeof createAttractSession>;
  try {
    session = createAttractSession({ recording: recordingJson });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    setText(byId("indicator-label"), "safety invariant: not checked");
    setText(byId("indicator-detail"), `The session could not start: ${detail}`);
    return;
  }
  setText(byId("scenario-title"), session.scenario.title);

  const names = createNames(layout, techniques);
  const log = new EventLog(names);
  const panel = createPanel(document);
  const labels = createLabels(document, byId("labels"), layout);
  const viewContext = createViewContext(network, session.index, layout);
  const ring = new ParticleRing();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer: MapRenderer | undefined;
  const detection = detectWebgl2(canvas);
  if (detection.ok && detection.gl) {
    renderer = new MapRenderer(detection.gl, layout, network, { reducedMotion });
  } else {
    showFallback(
      {
        canvas,
        labels: byId("labels"),
        fallback: byId("fallback"),
        message: byId("fallback-message"),
      },
      detection.reason ?? "WebGL2 is unavailable",
    );
  }

  let dpr = 1;
  const resize = (): void => {
    if (!renderer) return;
    const size = fitCanvas(canvas, window.devicePixelRatio);
    dpr = size.dpr;
    renderer.resize(size.width, size.height);
    labels.place(renderer.geometry(), dpr);
  };
  if (renderer) {
    new ResizeObserver(resize).observe(canvas);
    resize();
  }

  let loop: LoopHandle | undefined;
  if (renderer) {
    // The loop stops drawing while the context is gone and does not advance the
    // simulation then; when it is restored every GL resource is built again and
    // the particles start from empty, which changes nothing in the simulation.
    watchContext(canvas, {
      onLost() {
        loop?.pause();
        renderer?.release();
      },
      onRestored() {
        renderer?.rebuild();
        ring.clear();
        resize();
        loop?.resume();
      },
    });
  }

  let seenGeneration = session.generation();
  let shownTick = -1;
  const target = {
    advance(ticks: number): void {
      session.advance(ticks);
      if (session.generation() !== seenGeneration) {
        seenGeneration = session.generation();
        log.reset();
        ring.clear();
      }
      const events = session.drainEvents();
      log.ingest(events, session.scenario.startTick);
      for (const event of events) {
        if (event.k === "packet") for (const p of packetParticles(event, layout)) ring.push(p);
      }
    },
  };

  const render = (alpha: number): void => {
    const world = session.world();
    const view = buildView(world, viewContext, { prev: session.previous(), alpha });
    renderer?.draw(view, ring);
    if (world.tick !== shownTick) {
      shownTick = world.tick;
      labels.mark(world);
      panel.update(session, view, log);
    }
  };

  loop = startLoop(target, render);
}

boot();
