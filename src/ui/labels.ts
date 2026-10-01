import type { Layout } from "../content/layout";
import type { World } from "../core/sim/world";
import { ZONE_LABEL_DX, ZONE_LABEL_DY } from "../render/labelgeometry";
import type { NodeVisualState } from "../render/palette";
import type { Geometry } from "../render/renderer";
import { CONDUIT_LABEL_DY, NODE_LABEL_DY, nodeVisualState } from "../render/view";
import { h } from "./dom";

/**
 * Text on the map. Labels are DOM elements laid over the canvas, positioned from
 * the same fit as the GL scene, so text stays crisp and selectable at any zoom
 * and never goes through the shaders. All text is set as text, never as markup.
 */
export interface Labels {
  /**
   * Re-places every label for a canvas fit. `dpr` converts device to CSS pixels. Positions follow
   * `fit` (the camera); the font scale `--u` follows `fontScale` (the home fit), so under a
   * zoom the labels keep their size and only move.
   */
  place(fit: Geometry, dpr: number, fontScale?: number): void;
  /** Marks node labels with the state the map draws them in. */
  mark(world: World): void;
}

export function createLabels(
  doc: Document,
  container: HTMLElement,
  layout: Layout,
  conduitMarks: readonly { id: string; label: string; x: number; y: number }[] = [],
  /** Called with a conduit's id when its caption is clicked; the id comes from content, not the page. */
  onConduit?: (id: string) => void,
): Labels {
  interface Item {
    el: HTMLElement;
    x: number;
    y: number;
    /** Offset in map units from the anchor point. */
    dy: number;
  }
  const items: Item[] = [];
  const nodeEls = new Map<string, HTMLElement>();

  const add = (cls: string, text: string, x: number, y: number, dy = 0): HTMLElement => {
    const el = h(doc, "span", { class: cls }, text);
    container.append(el);
    items.push({ el, x, y, dy });
    return el;
  };

  for (const z of layout.zones)
    add("lbl lbl-zone", z.label, z.x + ZONE_LABEL_DX, z.y + ZONE_LABEL_DY);
  for (const [id, n] of Object.entries(layout.nodes)) {
    nodeEls.set(id, add("lbl lbl-node", n.label, n.x, n.y, NODE_LABEL_DY));
  }
  for (const s of layout.stations) add("lbl lbl-station", s.name, s.x, s.y);
  for (const c of conduitMarks) {
    const el = add("lbl lbl-conduit", c.label, c.x, c.y, CONDUIT_LABEL_DY);
    el.setAttribute("data-conduit", c.id);
    // The listener closes over the id from content; the attribute is for tests and styling only.
    if (onConduit !== undefined) el.addEventListener("click", () => onConduit(c.id));
  }

  const lastState = new Map<string, NodeVisualState>();
  return {
    place(fit, dpr, fontScale = fit.scale) {
      const css = fontScale / dpr;
      container.style.setProperty("--u", String(css));
      for (const item of items) {
        item.el.style.left = `${(fit.ox + item.x * fit.scale) / dpr}px`;
        item.el.style.top = `${(fit.oy + (item.y + item.dy) * fit.scale) / dpr}px`;
      }
    },
    mark(world) {
      for (const node of world.nodes) {
        const el = nodeEls.get(node.id);
        if (!el) continue;
        const state = nodeVisualState(node);
        if (lastState.get(node.id) === state) continue;
        lastState.set(node.id, state);
        el.setAttribute("data-state", state);
      }
    },
  };
}
