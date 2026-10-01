import type { AttractSession } from "../../app/session";
import type { RenderView } from "../../render/view";
import { setText, syncList } from "../dom";
import { loadPanelFonts } from "../fonts";
import { timeToDetect } from "./detect";
import { readInvariant, renderIndicator, renderRefusal } from "./indicator";
import { type EventLog, formatClock } from "./log";

/** Finds an element the page must have; a missing one is a build error, not a blank panel. */
function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

/** What the caption line says: a failure first, then the log's own caption, else the scenario's idle one. */
export function captionText(failure: string | undefined, logCaption: string, idle: string): string {
  if (failure !== undefined) return `The recording no longer matches the engine: ${failure}`;
  return logCaption || idle;
}

export interface Panel {
  update(session: AttractSession, view: RenderView, log: EventLog): void;
}

/** Drives the DOM panel beside the map. Every write is textContent or an attribute. */
export function createPanel(doc: Document): Panel {
  // Boot preload: start fetching the display face now; the page does not wait for it.
  void loadPanelFonts(doc.fonts);
  const indicator = {
    label: need(doc, "indicator-label"),
    detail: need(doc, "indicator-detail"),
  };
  const refusal = { text: need(doc, "refusal-text"), count: need(doc, "refusal-count") };
  const clock = need(doc, "clock");
  const caption = need(doc, "caption");
  const chain = need(doc, "chain");
  const logList = need(doc, "log");
  const alertList = need(doc, "alerts");
  const stat = {
    trains: need(doc, "stat-trains"),
    signals: need(doc, "stat-signals"),
    nodes: need(doc, "stat-nodes"),
    routes: need(doc, "stat-routes"),
    detect: need(doc, "stat-detect"),
  };

  return {
    update(session, view, log) {
      const status = session.status();
      renderIndicator(indicator, {
        assertedHeld: status.held,
        assertedViolations: status.violations,
        reading: readInvariant(session.world(), session.index),
        checkedTicks: status.checkedTicks,
      });

      setText(clock, formatClock(session.elapsedTicks()));

      const s = view.stats;
      setText(stat.trains, `${s.trains} on the line, ${s.trainsStanding} standing`);
      setText(stat.signals, `${s.signalsAtStop} of ${s.signals} at stop`);
      setText(stat.nodes, `${s.nodesCompromised} compromised, ${s.nodesLost} lost control`);
      setText(stat.detect, timeToDetect(session.world()));
      setText(stat.routes, `${s.routesSet} set, ${s.interlockingsDown} interlockings down`);

      const { latest, total } = log.refusal();
      renderRefusal(refusal, latest, total);

      setText(caption, captionText(status.failure, log.caption(), session.scenario.idleCaption));

      syncList(
        doc,
        chain,
        log.chain().map((step) => ({
          key: `op${step.op}`,
          text: step.technique,
          tone: step.state,
        })),
        "span",
      );
      syncList(
        doc,
        logList,
        log.simulation().map((e) => ({ key: e.key, text: e.text, tone: e.tone })),
      );
      syncList(
        doc,
        alertList,
        log.alerts().map((e) => ({ key: e.key, text: e.text, tone: e.tone })),
      );
    },
  };
}
