import type { Comparison, Outcome } from "../../core/replay/counterfactual";
import { TICKS_PER_SECOND } from "../../core/sim/constants";
import { h, setText } from "../dom";
import { timeToDetect } from "./detect";

/**
 * The comparison view (DEF-04): the same scenario run with no defense at all and with every
 * defense in place (the scenario's own sensors and the viewer's), side by side, with a sentence on what the difference is. It shows two
 * Outcomes the engine computed and draws nothing else; the numbers are the engine's.
 */

/** How the defended figure compares with the undefended one, from the numbers and not from the text. */
export type RowChange = "better" | "worse" | "same";

export interface CompareRow {
  label: string;
  without: string;
  with: string;
  change: RowChange;
}

/** Whole seconds from the first action to the first alert, or undefined when nothing was noticed. */
function secondsToDetect(o: Outcome): number | undefined {
  if (o.detectedAt === 0) return undefined;
  return Math.floor((o.detectedAt - o.firstActionTick) / TICKS_PER_SECOND);
}

const byCount = (without: number, withDefense: number, moreIsBetter: boolean): RowChange => {
  if (without === withDefense) return "same";
  return withDefense > without === moreIsBetter ? "better" : "worse";
};

/** Detected beats undetected, and earlier beats later. */
function detectChange(u: Outcome, d: Outcome): RowChange {
  const before = secondsToDetect(u);
  const after = secondsToDetect(d);
  if (before === undefined && after === undefined) return "same";
  if (before === undefined) return "better";
  if (after === undefined) return "worse";
  return byCount(before, after, false);
}

const detect = (o: Outcome, endTick: number): string =>
  timeToDetect({ tick: endTick, firstActionTick: o.firstActionTick, detectedAt: o.detectedAt });

/** The rows of the table: what each run came to at the end of the show. */
export function compareRows(c: Comparison, endTick: number): CompareRow[] {
  const row = (label: string, pick: (o: Outcome) => string, change: RowChange): CompareRow => ({
    label,
    without: pick(c.undefended),
    with: pick(c.defended),
    change,
  });
  const u = c.undefended;
  const d = c.defended;
  // A launch refused at a closed boundary counts like a payload stopped in flight.
  const stopped = (o: Outcome): number => o.blocked + o.refusedByDefense;
  return [
    row(
      "Signals at stop",
      (o) => `${o.signalsAtStop} of ${o.signals}`,
      byCount(u.signalsAtStop, d.signalsAtStop, false),
    ),
    row(
      "Trains standing",
      (o) => `${o.trainsStanding} of ${o.trains}`,
      byCount(u.trainsStanding, d.trainsStanding, false),
    ),
    row(
      "Machines compromised",
      (o) => String(o.compromised.length),
      byCount(u.compromised.length, d.compromised.length, false),
    ),
    row(
      "Command channels lost",
      (o) => String(o.commandChannelLost.length),
      byCount(u.commandChannelLost.length, d.commandChannelLost.length, false),
    ),
    row(
      "Interlockings out of service",
      (o) => String(o.interlockingsDown),
      byCount(u.interlockingsDown, d.interlockingsDown, false),
    ),
    row(
      "Attack steps stopped at a boundary",
      (o) => String(stopped(o)),
      byCount(stopped(u), stopped(d), true),
    ),
    row("IDS alerts", (o) => String(o.alerts), byCount(u.alerts, d.alerts, true)),
    row("Time to detect", (o) => detect(o, endTick), detectChange(u, d)),
  ];
}

/** One clause on how a count moved with the defenses ("2 fewer machines compromised"), or undefined when it did not. */
function moved(delta: number, what: string, one: string, many: string): string | undefined {
  if (delta === 0) return undefined;
  const n = Math.abs(delta);
  return `${n} ${delta > 0 ? "fewer" : "more"} ${n === 1 ? one : many} ${what}`;
}

/**
 * What the defenses changed, in one sentence. Every clause is a difference between the two
 * Outcomes and every row of the table that changed has one; a table with no difference says
 * so instead of inventing an effect.
 */
export function compareVerdict(c: Comparison): string {
  const u = c.undefended;
  const d = c.defended;
  if (u.hash === d.hash) {
    return "The defenses changed nothing: both runs end in exactly the same state.";
  }
  const parts = [
    moved(u.compromised.length - d.compromised.length, "compromised", "machine", "machines"),
    moved(
      u.commandChannelLost.length - d.commandChannelLost.length,
      "with the command channel lost",
      "machine",
      "machines",
    ),
    moved(u.signalsAtStop - d.signalsAtStop, "at stop", "signal", "signals"),
    moved(u.trainsStanding - d.trainsStanding, "standing", "train", "trains"),
    moved(
      u.blocked + u.refusedByDefense - (d.blocked + d.refusedByDefense),
      "stopped at a boundary",
      "attack step",
      "attack steps",
    ),
    moved(
      u.interlockingsDown - d.interlockingsDown,
      "out of service",
      "interlocking",
      "interlockings",
    ),
  ].filter((p): p is string => p !== undefined);
  const more = d.alerts - u.alerts;
  if (more !== 0)
    parts.push(
      `${Math.abs(more)} ${more > 0 ? "more" : "fewer"} ${Math.abs(more) === 1 ? "IDS alert" : "IDS alerts"}`,
    );
  const before = secondsToDetect(u);
  const after = secondsToDetect(d);
  if (before === undefined && after !== undefined) parts.push("the intruder is noticed");
  else if (before !== undefined && after === undefined) parts.push("the intruder goes unnoticed");
  else if (before !== undefined && after !== undefined && before !== after) {
    parts.push(
      `the intruder is noticed ${Math.abs(after - before)} s ${after < before ? "sooner" : "later"}`,
    );
  }
  if (parts.length === 0)
    return "Every figure in the table is the same with and without the defenses.";
  return `With the defenses: ${parts.join(", ")}.`;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html has no element #${id}`);
  return el as T;
}

export interface CompareDeps {
  /** How many defense actions the session holds, recorded and live. */
  defenseCount(): number;
  /** Runs both sides; only called when there is at least one defense. */
  run(): Comparison | undefined;
  /** The tick the show ends on, for the time-to-detect line. */
  endTick(): number;
}

export interface ComparePanel {
  update(): void;
  /** Forgets any result: the scenario changed or the show started over. */
  reset(): void;
}

export function createComparePanel(doc: Document, deps: CompareDeps): ComparePanel {
  const button = need<HTMLButtonElement>(doc, "compare-run");
  const note = need(doc, "compare-note");
  const table = need(doc, "compare-table");
  const body = need(doc, "compare-body");
  const verdict = need(doc, "compare-verdict");
  let shownFor: number | undefined;

  const clear = (): void => {
    while (body.firstChild) body.removeChild(body.firstChild);
    table.hidden = true;
    setText(verdict, "");
    shownFor = undefined;
  };

  button.addEventListener("click", () => {
    let result: Comparison | undefined;
    try {
      result = deps.run();
    } catch (error) {
      // A run that throws must never leave an old table or a calm screen behind.
      clear();
      setText(
        verdict,
        `The comparison could not be completed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return;
    }
    if (result === undefined) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const row of compareRows(result, deps.endTick())) {
      body.append(
        h(
          doc,
          "tr",
          {},
          h(doc, "th", { scope: "row" }, row.label),
          h(doc, "td", {}, row.without),
          h(doc, "td", { "data-change": row.change }, row.with),
        ),
      );
    }
    table.hidden = false;
    setText(verdict, compareVerdict(result));
    shownFor = deps.defenseCount();
  });

  return {
    update() {
      const count = deps.defenseCount();
      button.disabled = count === 0;
      if (shownFor !== undefined && shownFor !== count) {
        // The defenses changed since the last comparison: what is on screen no longer matches.
        setText(verdict, "Out of date: the defenses changed. Press Compare again.");
      }
      setText(
        note,
        count === 0
          ? "Place a defense first; then this runs the scenario to the end with and without it."
          : "Runs the scenario, same seed, to the end of the show twice: with no defense at all and with every defense in place (the scenario's own sensors and yours).",
      );
    },
    reset: clear,
  };
}
