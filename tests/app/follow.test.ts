import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFollowSwitch, DRAG_THRESHOLD_PX, FOLLOW_DISABLED_TITLE } from "../../src/app/follow";

describe("the Follow attack switch", () => {
  it("starts on and pressed, and the toggle flips both", () => {
    const follow = createFollowSwitch(false);
    expect(follow.enabled()).toBe(true);
    expect(follow.pressed()).toBe(true);
    expect(follow.disabled()).toBe(false);
    expect(follow.title()).toBe("");
    follow.toggle();
    expect(follow.enabled()).toBe(false);
    expect(follow.pressed()).toBe(false);
    follow.toggle();
    expect(follow.enabled()).toBe(true);
    expect(follow.pressed()).toBe(true);
  });

  it("is turned off by a wheel event", () => {
    const follow = createFollowSwitch(false);
    follow.wheel();
    expect(follow.enabled()).toBe(false);
    expect(follow.pressed()).toBe(false);
  });

  it("is turned off by a drag longer than 6 px, not by a click", () => {
    expect(DRAG_THRESHOLD_PX).toBe(6);
    const drag = createFollowSwitch(false);
    drag.pointerDown(0, 0);
    drag.pointerMove(7, 0);
    drag.pointerUp();
    expect(drag.enabled()).toBe(false);

    const click = createFollowSwitch(false);
    click.pointerDown(0, 0);
    click.pointerMove(5, 0);
    click.pointerUp();
    expect(click.enabled()).toBe(true);

    const exactly = createFollowSwitch(false);
    exactly.pointerDown(10, 10);
    exactly.pointerMove(16, 10);
    exactly.pointerUp();
    expect(exactly.enabled()).toBe(true);
  });

  it("measures a drag from the point where the pointer went down, in any direction", () => {
    const follow = createFollowSwitch(false);
    follow.pointerDown(100, 100);
    follow.pointerMove(104, 105);
    expect(follow.enabled()).toBe(false);
  });

  it("ignores pointer moves while no pointer is down, and a move after the pointer went up", () => {
    const hover = createFollowSwitch(false);
    hover.pointerMove(500, 500);
    hover.pointerMove(0, 0);
    expect(hover.enabled()).toBe(true);
    hover.pointerDown(0, 0);
    hover.pointerUp();
    hover.pointerMove(50, 50);
    expect(hover.enabled()).toBe(true);
  });

  it("does not come back on by itself after the viewer turned it off", () => {
    const follow = createFollowSwitch(false);
    follow.wheel();
    follow.pointerDown(0, 0);
    follow.pointerUp();
    expect(follow.enabled()).toBe(false);
  });

  it("is disabled and off with the reason in the title when reduced motion is on, and restores the viewer's own choice", () => {
    expect(FOLLOW_DISABLED_TITLE).toBe("Camera follow is off because reduced motion is on.");
    const follow = createFollowSwitch(true);
    expect(follow.disabled()).toBe(true);
    expect(follow.enabled()).toBe(false);
    expect(follow.pressed()).toBe(false);
    expect(follow.title()).toBe(FOLLOW_DISABLED_TITLE);
    follow.toggle();
    expect(follow.enabled()).toBe(false);
    follow.setReducedMotion(false);
    expect(follow.disabled()).toBe(false);
    expect(follow.enabled()).toBe(true);
    expect(follow.title()).toBe("");

    // The viewer's own last choice, not the default.
    follow.toggle();
    follow.setReducedMotion(true);
    expect(follow.enabled()).toBe(false);
    follow.setReducedMotion(false);
    expect(follow.enabled()).toBe(false);
    expect(follow.pressed()).toBe(false);
  });

  it("takes no input from the wheel or a drag while reduced motion is on", () => {
    const follow = createFollowSwitch(true);
    follow.wheel();
    follow.pointerDown(0, 0);
    follow.pointerMove(40, 0);
    follow.pointerUp();
    follow.setReducedMotion(false);
    expect(follow.enabled()).toBe(true);
  });
});

describe("the Follow attack pill in the page", () => {
  const html = readFileSync("index.html", "utf8");
  const button = /<button\b[^>]*\bid="follow-attack"[^>]*>([^<]*)<\/button>/.exec(html);

  it("is one pill with a fixed label of at most 14 characters, pressed at the start", () => {
    expect(html.match(/id="follow-attack"/g)).toHaveLength(1);
    expect(button?.[1]).toBe("Follow attack");
    expect(button?.[1]?.length ?? 99).toBeLessThanOrEqual(14);
    expect(button?.[0]).toContain('class="pill"');
    expect(button?.[0]).toContain('type="button"');
    expect(button?.[0]).toContain('aria-pressed="true"');
  });

  it("sits in the stage controls after the still, so the static fallback hides it", () => {
    const fallback = html.indexOf('id="fallback"');
    const controls = html.indexOf('id="stage-controls"');
    const pill = html.indexOf('id="follow-attack"');
    expect(fallback).toBeGreaterThan(0);
    expect(controls).toBeGreaterThan(fallback);
    expect(pill).toBeGreaterThan(controls);
    const css = readFileSync("src/ui/style.css", "utf8");
    expect(css).toMatch(/\.fallback:not\(\[hidden\]\) ~ \.stage-controls/);
  });
});
