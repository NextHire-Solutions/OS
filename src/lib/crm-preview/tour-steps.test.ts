/* The tour (4 Nov): it covers every page in the sidebar, in the sidebar's order, and its card always stays on screen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cardPlace, holeRadius, TOUR_STEPS } from "./tour-steps.ts";

const SCREEN = { width: 1512, height: 1000 };
const CARD = { width: 340, height: 190 };

test("every page in the sidebar has a step, in the sidebar's order, opening that page and pointing at its link", () => {
  const nav = readFileSync("src/components/crm-preview/crm-preview.tsx", "utf8");
  const sidebar = [...nav.matchAll(/\{ view: "(\w+)", label: "[^"]+", icon:/g)].map((m) => m[1]);
  assert.ok(sidebar.length >= 10, sidebar.join(", "));
  const steps = TOUR_STEPS.filter((s) => s.view);
  assert.deepEqual(steps.map((s) => s.view), sidebar);
  for (const s of steps) assert.equal(s.target, `nav a[href*="view=${s.view}"]`, s.title);
});

test("it starts with a welcome and ends on the chat; every step says something, with no email or phone number", () => {
  assert.equal(TOUR_STEPS[0].target, undefined);
  assert.equal(TOUR_STEPS.at(-1)!.target, "a.crx-aiask");
  for (const s of TOUR_STEPS) {
    assert.ok(s.title && s.text.length > 20, s.title);
    assert.doesNotMatch(s.text, /[^\s@]+@[^\s@]+\.[^\s@]+|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, s.title);
  }
  assert.equal(new Set(TOUR_STEPS.map((s) => s.title)).size, TOUR_STEPS.length);
});

test("the card: beside what it points at, on whichever side has room, and never off the screen", () => {
  // A sidebar link: to its right, level with it.
  assert.deepEqual(cardPlace({ top: 150, left: 12, width: 208, height: 36 }, CARD, SCREEN), { top: 150, left: 232 });
  // The chat button, bottom right: to its left, lifted clear of the bottom edge.
  const chat = cardPlace({ top: 916, left: 1428, width: 64, height: 64 }, CARD, SCREEN);
  assert.equal(chat.left, 1428 - 12 - 340);
  assert.ok(chat.top + CARD.height <= SCREEN.height - 16);
  // A sidebar link low on a short screen: lifted so the buttons stay on it.
  const low = cardPlace({ top: 690, left: 12, width: 208, height: 36 }, CARD, { width: 1024, height: 700 });
  assert.ok(low.top + CARD.height <= 700 - 16, String(low.top));
  // Nothing to point at: the middle.
  assert.deepEqual(cardPlace(null, CARD, SCREEN), { top: 405, left: 586 });
  // Whatever the screen and whatever it points at: on it.
  for (const screen of [{ width: 800, height: 500 }, { width: 1024, height: 700 }, SCREEN]) {
    for (const hole of [{ top: 10, left: 10, width: 200, height: 30 }, { top: screen.height - 70, left: screen.width - 70, width: 64, height: 64 }, null]) {
      const p = cardPlace(hole, CARD, screen);
      assert.ok(p.left >= 16 && p.left + CARD.width <= screen.width, JSON.stringify({ screen, hole, p }));
      assert.ok(p.top >= 16 && p.top + CARD.height <= screen.height, JSON.stringify({ screen, hole, p }));
    }
  }
});

test("the tour only looks: it saves nothing, and calls nothing", () => {
  const src = readFileSync("src/components/crm-preview/tour.tsx", "utf8");
  assert.doesNotMatch(src, /fetch\(|postDemo|useDemo|DemoContext/);
});

test("the highlight takes the shape of what it points at: a round chat button gets a round one, a menu row a soft corner", () => {
  assert.equal(holeRadius("50%", 56, 56), 32, "a circle, 4px out");
  assert.equal(holeRadius("999px", 56, 56), 32, "a circle written in pixels");
  assert.equal(holeRadius("8px", 200, 34), 12, "a menu row, 4px out");
  assert.equal(holeRadius("0px", 200, 34), 10, "never a sharp corner");
  assert.equal(holeRadius("", 200, 34), 10, "nothing readable");
  assert.equal(holeRadius("20%", 100, 50), 14, "a percentage of the short side");
});

test("Prospects: agents come off here and go on from Market, as the page has it (its list has no Add)", () => {
  const prospects = TOUR_STEPS.find((s) => s.title === "Prospects")!.text;
  assert.match(prospects, /Remove agents here, or add them from Market/);
  assert.doesNotMatch(prospects, /Add or remove agents here/);
  const market = readFileSync("src/components/crm-preview/market.tsx", "utf8");
  assert.match(market, /list === "market" \? <button[^\n]*moveAgents\("Prospects"\)/);
});
