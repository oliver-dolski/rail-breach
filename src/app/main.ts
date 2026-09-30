import "../ui/style.css";
import { layout } from "../content/layout";
import { network } from "../content/network";
import { techniques } from "../content/techniques";
import recordingJson from "../recordings/phishing-dispatcher.json";
import { screenToMap } from "../render/geometry";
import { detectWebgl2, fitCanvas, watchContext } from "../render/gl/context";
import { ALERT_COLORS, cssColor, DEFENSE_COLORS, SIGNAL_COLORS } from "../render/palette";
import { ParticleRing, packetParticles } from "../render/particleRing";
import { MapRenderer } from "../render/renderer";
import { buildView, createViewContext, nearestConduit } from "../render/view";
import { setText } from "../ui/dom";
import {
  CONTEXT_LOST_MESSAGE,
  RENDER_FAILED_MESSAGE,
  reportBootFailure,
  showFallback,
} from "../ui/fallback";
import { createLabels } from "../ui/labels";
import { createDefensePalette } from "../ui/panel/defense";
import { createNames, EventLog } from "../ui/panel/log";
import { createPanel } from "../ui/panel/panel";
import { createRefreshGate } from "../ui/panel/refresh";
import { type LoopHandle, startLoop } from "./loop";
import { attempt, browserTimers, CONTEXT_RESTORE_GRACE_MS, createLossGuard } from "./recovery";
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
  set("--defense", cssColor(DEFENSE_COLORS.barrier));
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
  const viewContext = createViewContext(network, session.index, layout);
  const labels = createLabels(document, byId("labels"), layout, viewContext.conduitMarks);
  const defenses = createDefensePalette(document, {
    content: network,
    onAction: (action) => session.dispatch(action),
    onReset: () => session.reset(),
  });
  const ring = new ParticleRing();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const fallbackEls = {
    canvas,
    labels: byId("labels"),
    fallback: byId("fallback"),
    message: byId("fallback-message"),
  };

  let renderer: MapRenderer | undefined;
  let loop: LoopHandle | undefined;

  /** The map is gone for good: show the still and keep the panel and the simulation running. */
  const dropRenderer = (message: string, reason: string): void => {
    renderer = undefined;
    showFallback(fallbackEls, reason, message);
    loop?.resume();
  };

  const detection = detectWebgl2(canvas);
  if (detection.ok && detection.gl) {
    // Some drivers hand out a WebGL2 context and then refuse a shader.
    const gl = detection.gl;
    renderer = attempt(
      () => new MapRenderer(gl, layout, network, { reducedMotion }),
      (reason) => showFallback(fallbackEls, reason, RENDER_FAILED_MESSAGE),
    );
  } else {
    showFallback(fallbackEls, detection.reason ?? "WebGL2 is unavailable");
  }

  let dpr = 1;
  const resize = (): void => {
    if (!renderer) return;
    const size = fitCanvas(canvas, window.devicePixelRatio);
    dpr = size.dpr;
    renderer.resize(size.width, size.height);
    labels.place(renderer.geometry(), dpr);
  };
  // A window dragged to a screen with another scale changes the pixel ratio
  // without resizing the canvas box, so the observer alone would miss it.
  const watchPixelRatio = (): void => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        resize();
        watchPixelRatio();
      },
      { once: true },
    );
  };
  if (renderer) {
    new ResizeObserver(resize).observe(canvas);
    watchPixelRatio();
    resize();
  }

  if (renderer) {
    // Clicking near a conduit places the armed defense on it. The pick is done here, on
    // the CPU, against the same layout the map is drawn from.
    const PICK_RADIUS_PX = 14;
    const conduitAt = (event: MouseEvent): string | undefined => {
      const fit = renderer?.geometry();
      if (!fit) return undefined;
      const rect = canvas.getBoundingClientRect();
      const at = screenToMap(fit, dpr, event.clientX - rect.left, event.clientY - rect.top);
      return nearestConduit(viewContext, at, (PICK_RADIUS_PX * dpr) / fit.scale);
    };
    canvas.addEventListener("click", (event) => {
      const conduit = conduitAt(event);
      if (conduit !== undefined) defenses.place(conduit);
    });
    canvas.addEventListener("pointermove", (event) => {
      const cursor = conduitAt(event) === undefined ? "default" : "pointer";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    });
  }

  if (renderer) {
    // The loop stops drawing while the context is gone and does not advance the
    // simulation then. If the browser restores it, every GL resource is built
    // again and the particles start from empty, which changes nothing in the
    // simulation. If it does not, the still takes over after a short grace period.
    const guard = createLossGuard(browserTimers, CONTEXT_RESTORE_GRACE_MS, () =>
      dropRenderer(CONTEXT_LOST_MESSAGE, "the context was not restored"),
    );
    watchContext(canvas, {
      onLost() {
        loop?.pause();
        renderer?.release();
        guard.lost();
      },
      onRestored() {
        guard.restored();
        if (!renderer) return;
        try {
          renderer.rebuild();
        } catch (error) {
          dropRenderer(
            CONTEXT_LOST_MESSAGE,
            error instanceof Error ? error.message : "unknown error",
          );
          return;
        }
        ring.clear();
        resize();
        loop?.resume();
      },
    });
  }

  let seenGeneration = session.generation();
  const gate = createRefreshGate();
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
    if (gate.changed(world.tick, session.status())) {
      labels.mark(world);
      panel.update(session, view, log);
      defenses.update(world, session.live());
    }
  };

  loop = startLoop(target, render);
}

try {
  boot();
} catch (error) {
  reportBootFailure(document, error);
}
