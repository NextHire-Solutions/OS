/*
 * The Location filter's reading and wording (13 Oct). The filtering is SQL
 * (analytics 097) and is tested there; this pins what travels between the
 * screen and the route, because a mismatch between the two is a table that
 * looks filtered and is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOCATION_ATTRIBUTES,
  LOCATION_FIELDS,
  MAX_CITIES_PER_FIELD,
  NO_LOCATION,
  cleanCities,
  isChosen,
  locationActive,
  locationCount,
  locationKey,
  locationLabel,
  locationParams,
  narrowCities,
  orderCities,
  readLocationParams,
  readLocations,
  toggleCity,
  type LocationSelection,
} from "./location-filter.ts";

const sel = (over: Partial<LocationSelection> = {}): LocationSelection => ({ ...NO_LOCATION, ...over });

test("the three fields are the ones asked for, reading the attributes the leads carry", () => {
  assert.deepEqual(LOCATION_FIELDS.map((f) => f.label), ["Office city", "Home city", "Most transacted city"]);
  // The names in lead_attributes — "top producing city" is what the Database calls Most Transacted City.
  assert.deepEqual(LOCATION_ATTRIBUTES, ["office city", "home city", "top producing city"]);
  assert.equal(new Set(LOCATION_FIELDS.map((f) => f.param)).size, 3);
});

test("cities are trimmed, blanks dropped, one of each whatever its case, order kept", () => {
  assert.deepEqual(cleanCities(["  Valencia, CA ", "", "valencia, ca", "Palmdale, CA", "   ", "PALMDALE, CA"]), ["Valencia, CA", "Palmdale, CA"]);
  assert.deepEqual(cleanCities([null, 7, undefined, { a: 1 }, "Newhall, CA"] as unknown[]), ["Newhall, CA"]);
  assert.equal(cleanCities(Array.from({ length: 400 }, (_, i) => `City ${i}, CA`)).length, MAX_CITIES_PER_FIELD);
});

test("no cities chosen is no filter", () => {
  assert.equal(locationActive(NO_LOCATION), false);
  assert.equal(locationCount(NO_LOCATION), 0);
  assert.deepEqual(locationParams(NO_LOCATION), []);
  assert.equal(readLocationParams(new URLSearchParams("page=1&q=smith")), null);
  assert.equal(readLocationParams(new URLSearchParams("loc_office=&loc_office=%20%20")), null, "blank values are not a filter");
});

test("what the screen sends is what the route reads — a round trip, per field", () => {
  const chosen = sel({ office: ["Valencia, CA", "Santa Clarita, CA"], top: ["Palmdale, CA"] });
  const query = new URLSearchParams({ page: "1" });
  for (const [k, v] of locationParams(chosen)) query.append(k, v);
  // Through a real address, commas and spaces included.
  const arrived = new URL(`http://os.test/x?${query.toString()}`).searchParams;
  assert.deepEqual(readLocationParams(arrived), {
    "office city": ["Valencia, CA", "Santa Clarita, CA"],
    "top producing city": ["Palmdale, CA"],
  });
});

test("a request cannot name an attribute of its own", () => {
  // Only loc_office / loc_home / loc_top are read; anything else is ignored.
  const q = new URLSearchParams("loc_phone=555&loc=Valencia&attr=sales%20volume&loc_home=Newhall%2C%20CA");
  assert.deepEqual(readLocationParams(q), { "home city": ["Newhall, CA"] });
});

test("the route caps a field, however many values arrive", () => {
  const q = new URLSearchParams();
  for (let i = 0; i < 300; i++) q.append("loc_office", `City ${i}, CA`);
  assert.equal(readLocationParams(q)!["office city"].length, MAX_CITIES_PER_FIELD);
});

test("the change key ignores order and case, and tells fields apart", () => {
  const a = sel({ office: ["Valencia, CA", "Palmdale, CA"] });
  assert.equal(locationKey(a), locationKey(sel({ office: ["palmdale, ca", "VALENCIA, CA"] })));
  assert.notEqual(locationKey(a), locationKey(sel({ top: ["Valencia, CA", "Palmdale, CA"] })), "same cities, another field");
  assert.notEqual(locationKey(a), locationKey(sel({ office: ["Valencia, CA"] })));
  assert.notEqual(locationKey(NO_LOCATION), locationKey(a));
  // Two cities in one field are not one city in each of two.
  assert.notEqual(locationKey(sel({ office: ["A", "B"] })), locationKey(sel({ office: ["A"], home: ["B"] })));
  // Moving a city from one field to the next is a different filter, even
  // though the same three cities are chosen in the same order.
  assert.notEqual(locationKey(sel({ office: ["A", "B"], home: ["C"] })), locationKey(sel({ office: ["A"], home: ["B", "C"] })));
});

test("the chip says what is applied", () => {
  assert.equal(locationLabel(NO_LOCATION), "Location");
  assert.equal(locationLabel(sel({ office: ["Valencia, CA"] })), "Location: Valencia, CA");
  assert.equal(locationLabel(sel({ top: ["Palmdale, CA"] })), "Location: Palmdale, CA");
  assert.equal(locationLabel(sel({ office: ["Valencia, CA", "Newhall, CA"], top: ["Palmdale, CA"] })), "Location: 3 cities");
});

test("ticking adds, ticking again removes, in any case, and stops at the cap", () => {
  let chosen: string[] = [];
  chosen = toggleCity(chosen, "Valencia, CA");
  chosen = toggleCity(chosen, "Palmdale, CA");
  assert.deepEqual(chosen, ["Valencia, CA", "Palmdale, CA"]);
  assert.equal(isChosen(chosen, "valencia, ca"), true);
  assert.deepEqual(toggleCity(chosen, "VALENCIA, CA"), ["Palmdale, CA"]);
  const full = Array.from({ length: MAX_CITIES_PER_FIELD }, (_, i) => `City ${i}, CA`);
  assert.equal(toggleCity(full, "One More, CA").length, MAX_CITIES_PER_FIELD, "a tick past the cap is refused");
  assert.equal(toggleCity(full, "City 3, CA").length, MAX_CITIES_PER_FIELD - 1, "but unticking still works");
});

const OPTIONS = [
  { value: "Valencia, CA", leads: 406 },
  { value: "Santa Clarita, CA", leads: 188 },
  { value: "Palmdale, CA", leads: 116 },
  { value: "Woodland Hills, CA", leads: 1 },
];

test("typing narrows the list by any part of the city, any case", () => {
  assert.deepEqual(narrowCities(OPTIONS, "  ").map((o) => o.value), OPTIONS.map((o) => o.value));
  assert.deepEqual(narrowCities(OPTIONS, "WOODLAND").map((o) => o.value), ["Woodland Hills, CA"]);
  assert.deepEqual(narrowCities(OPTIONS, "cla").map((o) => o.value), ["Santa Clarita, CA"]);
  assert.deepEqual(narrowCities(OPTIONS, "zz"), []);
});

test("what is already chosen is listed first; the rest keep the server's order", () => {
  assert.deepEqual(orderCities(OPTIONS, ["woodland hills, ca", "Palmdale, CA"]).map((o) => o.value),
    ["Woodland Hills, CA", "Palmdale, CA", "Valencia, CA", "Santa Clarita, CA"]);
  assert.deepEqual(orderCities(OPTIONS, []).map((o) => o.value), OPTIONS.map((o) => o.value));
});

test("a chosen city no longer in the campaign stays listed, at zero, so it can be unticked", () => {
  const list = orderCities(OPTIONS, ["Gone City, CA"]);
  assert.deepEqual(list[0], { value: "Gone City, CA", leads: 0 });
  assert.equal(list.length, OPTIONS.length + 1);
});

test("the server's answer is read by attribute name; anything malformed is an empty list", () => {
  const body = {
    "office city": [{ value: "Valencia, CA", leads: 406 }, { value: "  ", leads: 3 }, { leads: 9 }, null, { value: "Newhall, CA", leads: "92" }],
    "home city": [],
    "top producing city": "not a list",
    "sales volume": [{ value: "$1", leads: 1 }],
  };
  assert.deepEqual(readLocations(body), {
    office: [{ value: "Valencia, CA", leads: 406 }, { value: "Newhall, CA", leads: 92 }],
    home: [],
    top: [],
  });
  for (const junk of [null, undefined, "x", 4, []]) assert.deepEqual(readLocations(junk), { office: [], home: [], top: [] });
});
