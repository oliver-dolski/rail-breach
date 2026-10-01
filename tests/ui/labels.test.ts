import { describe, expect, it } from "vitest";
import { layout } from "../../src/content/layout";
import { network } from "../../src/content/network";
import { createViewContext } from "../../src/render/view";
import { createLabels } from "../../src/ui/labels";
import { networkIndex } from "../fixtures/attack";

const marks = createViewContext(network, networkIndex(), layout).conduitMarks;

interface El {
  attrs: Record<string, string>;
  textContent: string;
  style: { setProperty(name: string, value: string): void; left: string; top: string };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: () => void): void;
  append(...nodes: (El | string)[]): void;
  click(): void;
  readonly listeners: number;
}

/** Just enough of a document for the labels: spans with a class, text, attributes and click listeners. */
function fakeDocument() {
  const make = (): El => {
    const listeners: (() => void)[] = [];
    const el: El = {
      attrs: {},
      textContent: "",
      style: { setProperty() {}, left: "", top: "" },
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      getAttribute: (name) => el.attrs[name] ?? null,
      addEventListener(type, fn) {
        if (type === "click") listeners.push(fn);
      },
      append(...nodes) {
        for (const n of nodes) if (typeof n === "string") el.textContent += n;
      },
      click() {
        for (const fn of listeners) fn();
      },
      get listeners() {
        return listeners.length;
      },
    };
    return el;
  };
  const created: El[] = [];
  const doc = {
    createElement: () => {
      const el = make();
      created.push(el);
      return el;
    },
  } as unknown as Document;
  const container = { append() {}, style: { setProperty() {} } } as unknown as HTMLElement;
  return { doc, container, created };
}

const isConduit = (el: El): boolean => (el.attrs.class ?? "").includes("lbl-conduit");

describe("the conduit captions", () => {
  it("each carries the id of its conduit", () => {
    const { doc, container, created } = fakeDocument();
    createLabels(doc, container, layout, marks, () => {});
    const captions = created.filter(isConduit);
    expect(captions.map((el) => el.getAttribute("data-conduit")).sort()).toEqual(
      marks.map((m) => m.id).sort(),
    );
  });

  it("a click on the DMZ-Ctrl caption calls back with that conduit, once", () => {
    const { doc, container, created } = fakeDocument();
    const clicked: string[] = [];
    createLabels(doc, container, layout, marks, (id) => clicked.push(id));
    const caption = created.find((el) => el.textContent === "DMZ-Ctrl");
    expect(caption).toBeDefined();
    caption?.click();
    expect(clicked).toEqual(["c-dmz-ctrl"]);
  });

  it("acts on the id from content, not on what the attribute says now", () => {
    const { doc, container, created } = fakeDocument();
    const clicked: string[] = [];
    createLabels(doc, container, layout, marks, (id) => clicked.push(id));
    const caption = created.find((el) => el.textContent === "DMZ-Ctrl");
    caption?.setAttribute("data-conduit", "c-vendor-ctrl");
    caption?.click();
    expect(clicked).toEqual(["c-dmz-ctrl"]);
  });

  it("node, zone and station labels have no click listener", () => {
    const { doc, container, created } = fakeDocument();
    createLabels(doc, container, layout, marks, () => {});
    const others = created.filter((el) => !isConduit(el));
    expect(others.length).toBeGreaterThan(0);
    for (const el of others) expect(el.listeners).toBe(0);
  });

  it("without a callback no caption listens at all", () => {
    const { doc, container, created } = fakeDocument();
    createLabels(doc, container, layout, marks);
    for (const el of created) expect(el.listeners).toBe(0);
  });
});

describe("placing the captions under the camera", () => {
  it("sets the font scale from the home fit and the positions from the camera fit", () => {
    const { doc, created } = fakeDocument();
    const props: Record<string, string> = {};
    const container = {
      append() {},
      style: {
        setProperty(name: string, value: string) {
          props[name] = value;
        },
      },
    } as unknown as HTMLElement;
    const labels = createLabels(doc, container, layout, marks);
    const station = layout.stations[0];
    if (!station) throw new Error("no station");
    const el = created.find((e) => e.textContent === station.name);

    labels.place({ scale: 1.5, ox: 20, oy: 10 }, 2);
    expect(props["--u"]).toBe("0.75");
    expect(el?.style.left).toBe(`${(20 + station.x * 1.5) / 2}px`);

    // The camera zoomed in 1.3 times: positions move, the font scale stays the home one.
    labels.place({ scale: 1.95, ox: -300, oy: -120 }, 2, 1.5);
    expect(props["--u"]).toBe("0.75");
    expect(el?.style.left).toBe(`${(-300 + station.x * 1.95) / 2}px`);
    expect(el?.style.top).toBe(`${(-120 + station.y * 1.95) / 2}px`);
  });
});
