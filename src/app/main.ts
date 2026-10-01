import "../ui/style.css";
import { layout } from "../content/layout";
import { network } from "../content/network";
import { techniques } from "../content/techniques";
import type { Action } from "../core/sim/actions";
import type { World } from "../core/sim/world";
import { buildMapperContext } from "../mapper/context";
import { keywordMapper } from "../mapper/keyword";
import { createLlmMapper } from "../mapper/llm";
import { AlertFlashes } from "../render/flashes";
import { screenToMap } from "../render/geometry";
import { detectWebgl2, fitCanvas, watchContext } from "../render/gl/context";
import { ALERT_COLORS, cssColor, DEFENSE_COLORS, SIGNAL_COLORS } from "../render/palette";
import { ParticleRing, packetParticles } from "../render/particleRing";
import { MapRenderer } from "../render/renderer";
import { buildView, createViewContext, nearestConduit, reportingState } from "../render/view";
import { setText } from "../ui/dom";
import {
  CONTEXT_LOST_MESSAGE,
  RENDER_FAILED_MESSAGE,
  reportBootFailure,
  showFallback,
} from "../ui/fallback";
import { createLabels } from "../ui/labels";
import { createComparePanel } from "../ui/panel/compare";
import { createDefensePalette } from "../ui/panel/defense";
import { chipNamesFrom, createFreeText } from "../ui/panel/freetext";
import { createKeyPanel } from "../ui/panel/llmkey";
import { createNames, EventLog } from "../ui/panel/log";
import { createPanel } from "../ui/panel/panel";
import { createPicker } from "../ui/panel/picker";
import { createRefreshGate } from "../ui/panel/refresh";
import { createScenarioSelect } from "../ui/panel/scenario";
import { createTimelineView, Timeline } from "../ui/panel/timeline";
import { createViewToggle } from "../ui/panel/viewmode";
import { CAPTURE_FRAME_MS, createManualFrames, installCaptureHook } from "./capture";
import { catalog, entryFor } from "./catalog";
import { compareSession, defenseCount } from "./compare";
import { keystore } from "./keystore";
import { type LoopHandle, startLoop } from "./loop";
import { watchReducedMotion } from "./motion";
import { attempt, browserTimers, CONTEXT_RESTORE_GRACE_MS, createLossGuard } from "./recovery";
import { createAttractSession } from "./session";
import { switchScenario } from "./switch";

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

  const refuse = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : "unknown error";
    setText(byId("indicator-label"), "safety invariant: not checked");
    setText(byId("indicator-detail"), `The session could not start: ${detail}`);
  };

  // Attract mode: the first scenario plays from its committed recording with no user action.
  const first = catalog[0];
  if (first === undefined) {
    refuse(new Error("there is no scenario"));
    return;
  }
  let session: ReturnType<typeof createAttractSession>;
  try {
    session = createAttractSession({ scenario: first.scenario, recording: first.recording });
  } catch (error) {
    refuse(error);
    return;
  }

  const names = createNames(layout, techniques);
  const log = new EventLog(names);
  const panel = createPanel(document);
  let viewContext = createViewContext(network, session.index, layout);
  const sessionNote = byId("session-note");
  /** Hands an action to the session and says so on the page when it was refused. */
  const submit = (action: Action): void => setText(sessionNote, session.dispatch(action) ?? "");
  const defenses = createDefensePalette(document, {
    content: network,
    onAction: submit,
    onReset: () => session.reset(),
  });
  // A conduit caption is a click target too: it places the armed defense like a click on the line.
  const labels = createLabels(document, byId("labels"), layout, viewContext.conduitMarks, (id) =>
    defenses.place(id),
  );
  const mapperContext = buildMapperContext(network, techniques);
  createPicker(document, { ctx: mapperContext, onAction: submit });
  // With no key the LLM mapper hands straight over to the keywords, and it does so on any failure too.
  const keyPanel = createKeyPanel(document, keystore);
  createFreeText(document, {
    ctx: mapperContext,
    names: chipNamesFrom(layout),
    mapper: createLlmMapper({ keystore, fallback: keywordMapper, model: keyPanel.model }),
    onAction: submit,
  });
  const timeline = new Timeline(names);
  const timelineView = createTimelineView(document);
  const compare = createComparePanel(document, {
    defenseCount: () => defenseCount(session),
    run: () => compareSession(session),
    endTick: () => session.recording.durationTicks,
  });
  const ring = new ParticleRing();
  const flashes = new AlertFlashes();
  const viewToggle = createViewToggle(document);
  /** The last world whose operator feed was good: what a frozen console keeps showing. */
  let lastGood: World | undefined;
  // The OS setting can change while the show runs; the map and the flashes follow it live.
  const motion = watchReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)"), (on) => {
    reducedMotion = on;
    renderer?.setReducedMotion(on);
  });
  let reducedMotion = motion.current();

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
  let gate = createRefreshGate();

  /** Starts another scenario from its own recording and clears everything the last one left on screen. */
  const switchTo = (id: string): void =>
    switchScenario(id, {
      runningId: () => session.scenario.id,
      build: (wanted) => {
        const entry = entryFor(wanted);
        return entry === undefined
          ? undefined
          : createAttractSession({ scenario: entry.scenario, recording: entry.recording });
      },
      adopt: (next, wanted) => {
        session = next;
        viewContext = createViewContext(network, session.index, layout);
        seenGeneration = session.generation();
        gate = createRefreshGate();
        log.reset();
        ring.clear();
        flashes.clear();
        timeline.reset();
        compare.reset();
        lastGood = undefined;
        selector.show(wanted);
      },
      restore: (running) => selector.show(running),
      say: (text) => setText(sessionNote, text),
    });
  const selector = createScenarioSelect(
    document,
    catalog.map((e) => ({
      id: e.scenario.id,
      title: e.scenario.title,
      summary: e.scenario.summary,
    })),
    switchTo,
  );
  selector.show(session.scenario.id);
  const target = {
    advance(ticks: number): void {
      session.advance(ticks);
      if (session.generation() !== seenGeneration) {
        seenGeneration = session.generation();
        log.reset();
        ring.clear();
        flashes.clear();
        timeline.reset();
        compare.reset();
        lastGood = undefined;
      }
      const events = session.drainEvents();
      log.ingest(events, session.scenario.startTick);
      timeline.ingest(events, session.scenario.startTick);
      flashes.ingest(events);
      for (const event of events) {
        if (event.k === "packet") for (const p of packetParticles(event, layout)) ring.push(p);
      }
    },
  };

  const render = (alpha: number): void => {
    const world = session.world();
    if (reportingState(world) === "ok") lastGood = world;
    const prev = session.previous();
    const phase = (prev?.tick ?? world.tick) + alpha;
    const view = buildView(world, viewContext, {
      prev,
      alpha,
      mode: viewToggle.mode(),
      lastGood,
      alerts: flashes.levels(phase, reducedMotion),
    });
    renderer?.draw(view, ring);
    if (gate.changed(world.tick, session.status())) {
      labels.mark(world);
      viewToggle.note(view.reporting);
      panel.update(session, view, log);
      defenses.update(world, session.live());
      timelineView.update(
        timeline.model(
          world,
          session.scenario.startTick,
          session.recording.durationTicks - session.scenario.startTick,
        ),
        world,
      );
      compare.update();
    }
  };

  if (import.meta.env.MODE === "capture") {
    // Only the capture build gets here: the media script steps the frames, 40 ms each, and the
    // simulation, the recording and the render are exactly the ones the page ships.
    const manual = createManualFrames(CAPTURE_FRAME_MS);
    loop = startLoop(target, render, { deps: manual.deps });
    installCaptureHook(manual);
  } else {
    loop = startLoop(target, render);
  }
}

try {
  boot();
} catch (error) {
  reportBootFailure(document, error);
}
