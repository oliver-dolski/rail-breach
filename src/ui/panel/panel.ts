import type { AttractSession } from "../../app/session";
import type { RenderView } from "../../render/view";
import { setText, syncList } from "../dom";
import { readInvariant, renderIndicator, renderRefusal } from "./indicator";
import { type EventLog, formatClock } from "./log";

/** Finds an element the page must have; a missing one is a build error, not a blank panel. */
function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface Panel {
  update(session: AttractSession, view: RenderView, log: EventLog): void;
}

/** Drives the DOM panel beside the map. Every write is textContent or an attribute. */
export function createPanel(doc: Document): Panel {
  const indicator = {
    label: need(doc, "indicator-label"),
    detail: need(doc, "indicator-detail"),
  };
  const refusal = { text: need(doc, "refusal-text"), count: need(doc, "refusal-count") };
  const clock = need(doc, "clock");
  const caption = need(doc, "caption");
  const chain = need(doc, "chain");
  const logList = need(doc, "log");
  const stat = {
    trains: need(doc, "stat-trains"),
    signals: need(doc, "stat-signals"),
    nodes: need(doc, "stat-nodes"),
    routes: need(doc, "stat-routes"),
  };

  return {
    update(session, view, log) {
      const status = session.status();
      renderIndicator(indicator, {
        assertedHeld: status.held,
        reading: readInvariant(session.world(), session.index),
        checkedTicks: status.checkedTicks,
      });

      setText(clock, formatClock(session.elapsedTicks()));

      const s = view.stats;
      setText(stat.trains, `${s.trains} on the line, ${s.trainsStanding} standing`);
      setText(stat.signals, `${s.signalsAtStop} of ${s.signals} at stop`);
      setText(stat.nodes, `${s.nodesCompromised} compromised, ${s.nodesLost} lost control`);
      setText(stat.routes, `${s.routesSet} set, ${s.interlockingsDown} interlockings down`);

      const { latest, total } = log.refusal();
      renderRefusal(refusal, latest, total);

      setText(
        caption,
        status.failure !== undefined
          ? `The recording no longer matches the engine: ${status.failure}`
          : log.caption() || "A quiet railway. Watch the dispatcher's office workstation.",
      );

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
        log.entries().map((e) => ({ key: e.key, text: e.text, tone: e.tone })),
      );
    },
  };
}
