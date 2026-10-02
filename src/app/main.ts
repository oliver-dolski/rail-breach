import "../ui/style.css";
import { layout } from "../content/layout";
import { network } from "../content/network";
import { techniques } from "../content/techniques";
import type { Action } from "../core/sim/actions";
import { TICKS_PER_SECOND } from "../core/sim/constants";
import type { World } from "../core/sim/world";
import { buildMapperContext } from "../mapper/context";
import { keywordMapper } from "../mapper/keyword";
import { createLlmMapper } from "../mapper/llm";
import { CameraTrack } from "../render/camera";
import { AlertFlashes } from "../render/flashes";
import { screenToMap } from "../render/geometry";
import { detectWebgl2, fitCanvas, watchContext } from "../render/gl/context";
import { INTRO_LEVEL_NAMES, introLevels } from "../render/intro/levels";
import { partitionView } from "../render/intro/partition";
import { INTRO_MS, introPose } from "../render/intro/pose";
import { ALERT_COLORS, cssColor, DEFENSE_COLORS, SIGNAL_COLORS } from "../render/palette";
import { ParticleRing, packetParticles } from "../render/particleRing";
import { MapRenderer } from "../render/renderer";
import { AttackTrail } from "../render/trail";
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
import { createFollowSwitch } from "./follow";
import {
  createIntro,
  gateTarget,
  INTRO_END_TEXT,
  INTRO_START_TEXT,
  type IntroClock,
  shouldPlayIntro,
} from "./intro";
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
  const labels = createLabels(document, byId("labels"), layout, viewContext.conduitMarks, (id) => {
    if (intro?.running()) skipIntro();
    else defenses.place(id);
  });
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
  const trail = new AttackTrail(layout);
  const camera = new CameraTrack(layout);
  const viewToggle = createViewToggle(document);
  /** The last world whose operator feed was good: what a frozen console keeps showing. */
  let lastGood: World | undefined;
  // The OS setting can change while the show runs; the map and the flashes follow it live.
  const motion = watchReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)"), (on) => {
    reducedMotion = on;
    if (on) endIntro();
    syncReplay();
    renderer?.setReducedMotion(on);
    follow.setReducedMotion(on);
    syncFollow();
  });
  let reducedMotion = motion.current();
  const follow = createFollowSwitch(reducedMotion);
  const followButton = byId<HTMLButtonElement>("follow-attack");
  /** The pill shows what the switch says: pressed while the camera follows, disabled with a reason under reduced motion. */
  let shownPressed: boolean | undefined;
  const syncFollow = (): void => {
    // Pointer moves call this too; the page is only written when the switch really changed.
    if (shownPressed === follow.pressed() && followButton.disabled === follow.disabled()) return;
    shownPressed = follow.pressed();
    followButton.setAttribute("aria-pressed", String(shownPressed));
    followButton.disabled = follow.disabled();
    followButton.title = follow.title();
  };
  syncFollow();
  followButton.addEventListener("click", () => {
    follow.toggle();
    syncFollow();
  });

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
    endIntro();
    showFallback(fallbackEls, reason, message);
    loop?.resume();
  };

  const detection = detectWebgl2(canvas);
  if (detection.ok && detection.gl) {
    // Some drivers hand out a WebGL2 context and then refuse a shader.
    const gl = detection.gl;
    renderer = attempt(
      () =>
        new MapRenderer(gl, layout, network, {
          reducedMotion,
          capture: import.meta.env.MODE === "capture",
        }),
      (reason) => showFallback(fallbackEls, reason, RENDER_FAILED_MESSAGE),
    );
    // The tier is a fact about this GPU; the smoke script reads it from here. setAttribute, not
    // dataset: the production bundle must not hold the capture build's dataset pattern.
    if (renderer) document.documentElement.setAttribute("data-render-tier", renderer.tier());
  } else {
    showFallback(fallbackEls, detection.reason ?? "WebGL2 is unavailable");
  }

  let dpr = 1;
  /** What the labels were last placed for, so a still camera costs no style writes. */
  let placedFor: { scale: number; ox: number; oy: number; home: number; dpr: number } | undefined;
  /** Moves the labels with the camera; their size follows the home fit, so they only slide. */
  const placeLabels = (force: boolean): void => {
    if (!renderer) return;
    const fit = renderer.geometry();
    const home = renderer.homeGeometry().scale;
    const was = placedFor;
    if (
      !force &&
      was !== undefined &&
      was.scale === fit.scale &&
      was.ox === fit.ox &&
      was.oy === fit.oy &&
      was.home === home &&
      was.dpr === dpr
    ) {
      return;
    }
    placedFor = { scale: fit.scale, ox: fit.ox, oy: fit.oy, home, dpr };
    labels.place(fit, dpr, home);
  };
  const resize = (): void => {
    if (!renderer) return;
    const size = fitCanvas(canvas, window.devicePixelRatio);
    dpr = size.dpr;
    renderer.resize(size.width, size.height);
    placeLabels(true);
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
      if (intro?.running()) {
        skipIntro();
        return;
      }
      const conduit = conduitAt(event);
      if (conduit !== undefined) defenses.place(conduit);
    });
    // The viewer takes the camera back with the wheel or a drag; a click that places a defense is neither.
    canvas.addEventListener(
      "wheel",
      () => {
        follow.wheel();
        syncFollow();
      },
      { passive: true },
    );
    const localPoint = (event: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    canvas.addEventListener("pointerdown", (event) => follow.pointerDown(...localPoint(event)));
    canvas.addEventListener("pointermove", (event) => {
      follow.pointerMove(...localPoint(event));
      syncFollow();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
      canvas.addEventListener(type, () => follow.pointerUp());
    }
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
        endIntro();
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

  // The intro plays on the first load and on Replay, and only where the GPU path is sound. It
  // holds the simulation still: the loop target below is gated for as long as it runs.
  const html = document.documentElement;
  // Only the intro=0 flag is ever read from the address (see shouldPlayIntro); the key never is.
  const { search } = window.location;
  const labelsEl = byId("labels");
  const namesEl = byId("intro-names");
  const panelEl = byId("panel");
  const statusEl = byId("intro-status");
  const skipButton = byId<HTMLButtonElement>("intro-skip");
  const replayButton = byId<HTMLButtonElement>("intro-replay");
  let intro: IntroClock | undefined;
  /** True from the start of an intro until finishIntro has put the page back. */
  let introShown = false;
  /** True once the layers are flat and the board is cross-fading in: the panel is back by then. */
  let introFading = false;
  let levels: ReturnType<typeof introLevels> = [];
  const levelNames: HTMLSpanElement[] = INTRO_LEVEL_NAMES.map((text) => {
    const el = document.createElement("span");
    el.className = "intro-name";
    el.textContent = text;
    namesEl.append(el);
    return el;
  });
  /** Name widths in CSS pixels, measured once the display face is in. */
  let nameWidths: number[] = [];
  void document.fonts.ready.then(() => {
    nameWidths = [];
  });

  /** Whether an intro could play now, leaving out whether it already has (Replay asks this). */
  const canPlayIntro = (): boolean =>
    shouldPlayIntro({
      reducedMotion,
      search,
      tier: renderer?.tier(),
      fallback: renderer === undefined,
      stageWidthCss: canvas.clientWidth,
      firstLoad: true,
    });
  /** Replay intro is shown only where the intro could play. */
  const syncReplay = (): void => {
    replayButton.hidden = !canPlayIntro();
  };
  /** The viewer may use the panel again: the layers are flat and the board is coming in. */
  const releasePanel = (): void => {
    if (introFading) return;
    introFading = true;
    panelEl.inert = false;
    skipButton.hidden = true;
    for (const el of levelNames) el.style.opacity = "0";
  };
  /** Puts the page back to normal: labels, panel and controls as before. Safe to call twice. */
  const finishIntro = (): void => {
    intro?.end();
    if (!introShown) return;
    introShown = false;
    releasePanel();
    labelsEl.style.opacity = "";
    html.setAttribute("data-intro", "done");
    setText(statusEl, INTRO_END_TEXT);
  };
  /** An error, a lost context or a weak GPU: the board is shown at once. */
  const endIntro = (): void => {
    if (introShown) finishIntro();
    syncReplay();
  };
  /** Begins an intro on the show as it stands: the first load, or Replay intro. */
  const startIntro = (): void => {
    intro = createIntro(INTRO_MS);
    introShown = true;
    introFading = false;
    camera.reset();
    levels = levels.length > 0 ? levels : introLevels(network, layout);
    labelsEl.style.opacity = "0";
    panelEl.inert = true;
    skipButton.hidden = false;
    html.setAttribute("data-intro", "running");
    html.setAttribute("data-intro-played", "");
    setText(statusEl, INTRO_START_TEXT);
  };
  /**
   * Puts each level name beside its projected layer, in one column at the right of the stack. A
   * column that would run off the stage moves in, over the empty right end of the plates, and the
   * names then sit at the top of their plate so they stay clear of the zones.
   */
  const placeNames = (
    boxes: readonly { x0: number; y0: number; x1: number; y1: number }[],
    alpha: number,
  ): void => {
    if (nameWidths.length !== levelNames.length)
      nameWidths = levelNames.map((el) => el.offsetWidth);
    const widest = Math.max(0, ...nameWidths);
    const stageWidth = canvas.clientWidth;
    const right = Math.max(0, ...boxes.map((b) => b.x1 / dpr));
    const column = Math.min(right + 14, stageWidth - widest - 10);
    const inside = column < right + 14;
    levelNames.forEach((el, i) => {
      const box = boxes[i];
      if (!box) return;
      const top = inside ? box.y0 / dpr + 6 : (box.y0 + box.y1) / 2 / dpr - 10;
      el.style.transform = `translate(${Math.round(column)}px, ${Math.round(top)}px)`;
      el.style.opacity = String(alpha);
    });
  };

  // Skip: the pill, a click on the map or on a conduit caption, and Escape, Space or Enter.
  const skipIntro = (): void => intro?.skip();
  skipButton.addEventListener("click", skipIntro);
  document.addEventListener("keydown", (event) => {
    if (intro?.running() !== true) return;
    if (event.key === "Escape") {
      skipIntro();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      skipIntro();
    }
  });

  if (canPlayIntro()) startIntro();
  else html.setAttribute("data-intro", "off");
  syncReplay();
  // The stage width is one of the conditions too: a stage made too narrow loses Replay intro.
  if (renderer) new ResizeObserver(syncReplay).observe(canvas);

  /** Clears everything the last run of the show left on screen, for a restart, a new scenario or Replay. */
  const clearShow = (): void => {
    log.reset();
    ring.clear();
    flashes.clear();
    trail.clear();
    camera.reset();
    timeline.reset();
    compare.reset();
    lastGood = undefined;
  };

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
        clearShow();
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
  const sim = {
    advance(ticks: number): void {
      // One tick at a time: the camera takes one step per simulation tick, whatever the frame length.
      for (let i = 0; i < ticks; i++) {
        const before = session.world();
        session.advance(1);
        // A halted or failed session does not tick, and the camera freezes with it.
        if (session.world() === before) break;
        if (session.generation() !== seenGeneration) {
          seenGeneration = session.generation();
          clearShow();
        }
        const events = session.drainEvents();
        log.ingest(events, session.scenario.startTick);
        timeline.ingest(events, session.scenario.startTick);
        flashes.ingest(events);
        trail.ingest(events);
        for (const event of events) {
          if (event.k === "packet") for (const p of packetParticles(event, layout)) ring.push(p);
        }
        camera.step({
          world: session.world(),
          zoneOfNode: viewContext.nodeZone,
          enabled: follow.enabled(),
          reducedMotion,
        });
      }
    },
  };

  // The simulation stands still while an intro runs, whichever intro is current.
  const target = gateTarget(sim, { running: () => intro?.running() === true });

  replayButton.addEventListener("click", () => {
    if (intro?.running() || !canPlayIntro()) return;
    // The whole show starts over under the intro, as for Start over, and nothing of the last run stays.
    session.reset();
    seenGeneration = session.generation();
    gate = createRefreshGate();
    clearShow();
    startIntro();
  });

  const render = (frameAlpha: number, dtMs: number): void => {
    // A GPU that cannot keep up steps down to plain glow, once; the simulation never hears of it.
    if (renderer?.noteFrame(dtMs)) {
      document.documentElement.setAttribute("data-render-tier", renderer.tier());
      endIntro();
    }
    if (intro && introShown) {
      if (intro.running()) intro.feed(dtMs);
      if (!intro.running() || renderer === undefined) finishIntro();
      else if (intro.phase() === "crossfade") releasePanel();
    }
    const introOn = intro?.running() === true;
    // While the intro runs the world is the first one and stands still: no interpolation.
    const alpha = introOn ? 0 : frameAlpha;
    const world = session.world();
    if (reportingState(world) === "ok") lastGood = world;
    const prev = introOn ? undefined : session.previous();
    const phase = (prev?.tick ?? world.tick) + alpha;
    const view = buildView(world, viewContext, {
      prev,
      alpha,
      mode: viewToggle.mode(),
      lastGood,
      alerts: flashes.levels(phase, reducedMotion),
      trail: trail.lines(phase / TICKS_PER_SECOND, reducedMotion),
    });
    if (renderer) {
      renderer.setCamera(camera.pose(alpha));
      placeLabels(false);
    }
    if (intro && introOn && renderer) {
      const elapsed = intro.elapsedMs();
      if (intro.phase() === "layers") {
        try {
          const pose = introPose(elapsed, canvas.clientWidth / Math.max(1, canvas.clientHeight));
          const boxes = renderer.drawIntro(view, {
            elapsedMs: elapsed,
            levels,
            partition: partitionView(view, viewContext, levels),
            ctx: viewContext,
          });
          placeNames(boxes, pose.namesAlpha);
        } catch {
          // Any trouble in the intro path ends it; the board is drawn at once.
          endIntro();
          renderer.draw(view, ring);
        }
      } else {
        labelsEl.style.opacity = String(introPose(elapsed, 1).labelsAlpha);
        renderer.draw(view, ring);
      }
    } else {
      renderer?.draw(view, ring);
    }
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
