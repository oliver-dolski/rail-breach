import type { Layout } from "../content/layout";
import type { World } from "../core/sim/world";
import type { NodeVisualState } from "../render/palette";
import type { Geometry } from "../render/renderer";
import { nodeVisualState } from "../render/view";
import { h } from "./dom";

/**
 * Text on the map. Labels are DOM elements laid over the canvas, positioned from
 * the same fit as the GL scene, so text stays crisp and selectable at any zoom
 * and never goes through the shaders. All text is set as text, never as markup.
 */
export interface Labels {
  /** Re-places every label for a new canvas fit. `dpr` converts device to CSS pixels. */
  place(fit: Geometry, dpr: number): void;
  /** Marks node labels with the state the map draws them in. */
  mark(world: World): void;
}

export function createLabels(doc: Document, container: HTMLElement, layout: Layout): Labels {
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

  for (const z of layout.zones) add("lbl lbl-zone", z.label, z.x + 8, z.y + 6);
  for (const [id, n] of Object.entries(layout.nodes)) {
    nodeEls.set(id, add("lbl lbl-node", n.label, n.x, n.y, 15));
  }
  for (const s of layout.stations) add("lbl lbl-station", s.name, s.x, s.y);

  const lastState = new Map<string, NodeVisualState>();
  return {
    place(fit, dpr) {
      const css = fit.scale / dpr;
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
