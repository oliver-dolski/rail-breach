import { findViolations } from "../../core/rail/invariants";
import type { SimEvent } from "../../core/sim/events";
import type { Index } from "../../core/sim/model";
import type { World } from "../../core/sim/world";
import { setText, type Textual } from "../dom";

/** What the indicator needs from an element: text, and one attribute for styling. */
export interface IndicatorElement extends Textual {
  setAttribute(name: string, value: string): void;
}

export interface IndicatorEls {
  label: IndicatorElement;
  detail: IndicatorElement;
}

export interface InvariantReading {
  held: boolean;
  violations: readonly string[];
}

/**
 * Reads the safety invariant straight from the core: the same checks that
 * assertInvariants runs on every tick, evaluated on the world being drawn.
 * Read-only, so it can be polled every frame.
 */
export function readInvariant(world: World, index: Index): InvariantReading {
  const violations = findViolations(world, index);
  return { held: violations.length === 0, violations };
}

export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface IndicatorInput {
  /** Whether every tick so far passed the core's assertion. */
  assertedHeld: boolean;
  /** Result of reading the invariant on the world on screen. */
  reading: InvariantReading;
  checkedTicks: number;
}

export function indicatorText(input: IndicatorInput): {
  label: string;
  detail: string;
  held: boolean;
} {
  const held = input.assertedHeld && input.reading.held;
  if (held) {
    return {
      label: "safety invariant: HELD",
      detail: `checked by the core on every tick - ${groupDigits(input.checkedTicks)} ticks so far`,
      held,
    };
  }
  const first = input.reading.violations[0] ?? "reported by the core";
  return { label: "safety invariant: BREACHED", detail: first, held };
}

/** Writes the indicator. Text only, through textContent. */
export function renderIndicator(els: IndicatorEls, input: IndicatorInput): void {
  const view = indicatorText(input);
  setText(els.label, view.label);
  setText(els.detail, view.detail);
  els.label.setAttribute("data-state", view.held ? "held" : "breached");
}

type Rejected = Extract<SimEvent, { k: "command.rejected" }>;

/** One refusal in plain words, as shown to the viewer. */
export function formatRefusal(event: Rejected): string {
  const who = event.il === "" ? "The interlocking" : event.il;
  const what = event.route === "" ? "a command" : `route ${event.route}`;
  return `${who} refused ${what}: ${event.reason}`;
}

export interface RefusalEls {
  text: Textual;
  count: Textual;
}

/** Shows the latest refusal and how many there have been in this run. */
export function renderRefusal(els: RefusalEls, latest: Rejected | undefined, total: number): void {
  setText(
    els.text,
    latest === undefined
      ? "none yet - every command is checked against the interlocking"
      : formatRefusal(latest),
  );
  setText(els.count, `${groupDigits(total)} refused in this run`);
}
