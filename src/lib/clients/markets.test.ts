import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  MARKET_MAX,
  clean,
  marketKey,
  marketLabel,
  sortMarkets,
  suggestionsFrom,
  validateMarket,
  type MarketRow,
} from "./markets.ts";

const row = (id: string, market: string, mls: string | null = null, area: string | null = null): MarketRow =>
  ({ id, market, mls, area });

describe("clean", () => {
  test("trims every field", () => {
    assert.deepEqual(clean({ market: "  Boston  ", mls: " MLS PIN ", area: "  Suffolk " }), {
      market: "Boston", mls: "MLS PIN", area: "Suffolk",
    });
  });

  test("a blank optional field becomes null, not an empty string", () => {
    // A form submits an untouched input as "". Storing that would make a row the
    // unique index treats as identical to a null one, while the UI shows two.
    assert.deepEqual(clean({ market: "Boston", mls: "", area: "   " }), {
      market: "Boston", mls: null, area: null,
    });
  });

  test("undefined and null optionals both become null", () => {
    assert.deepEqual(clean({ market: "Boston" }), { market: "Boston", mls: null, area: null });
    assert.deepEqual(clean({ market: "Boston", mls: null, area: null }),
      { market: "Boston", mls: null, area: null });
  });
});

describe("marketKey — must match migration 0017's unique index", () => {
  test("case does not make a different market", () => {
    assert.equal(marketKey({ market: "Boston" }), marketKey({ market: "boston" }));
    assert.equal(marketKey({ market: "BOSTON" }), marketKey({ market: "boston" }));
  });

  test("surrounding whitespace does not make a different market", () => {
    assert.equal(marketKey({ market: "  Boston  " }), marketKey({ market: "Boston" }));
  });

  test("a blank MLS and a null MLS are the same row", () => {
    // This is the coalesce(..., '') half of the index. It is the common case,
    // because MLS is optional.
    assert.equal(marketKey({ market: "Boston", mls: "" }), marketKey({ market: "Boston", mls: null }));
    assert.equal(marketKey({ market: "Boston", mls: "  " }), marketKey({ market: "Boston" }));
  });

  test("different MLS in the same market ARE different rows", () => {
    assert.notEqual(
      marketKey({ market: "Boston", mls: "MLS PIN" }),
      marketKey({ market: "Boston", mls: "MLS Other" }),
    );
  });

  test("the same MLS in different markets ARE different rows", () => {
    assert.notEqual(
      marketKey({ market: "Boston", mls: "MLS PIN" }),
      marketKey({ market: "Florida", mls: "MLS PIN" }),
    );
  });

  test("area participates in identity", () => {
    assert.notEqual(
      marketKey({ market: "Florida", area: "Miami Dade" }),
      marketKey({ market: "Florida", area: "Broward" }),
    );
  });

  test("fields cannot bleed into one another", () => {
    // A naive join on "-" would make these two collide. The separator is NUL,
    // which cannot appear in a Postgres text value.
    assert.notEqual(
      marketKey({ market: "a", mls: "b" }),
      marketKey({ market: "a-b" }),
    );
  });
});

describe("validateMarket", () => {
  test("a market is required", () => {
    assert.deepEqual(validateMarket({ market: "" }), { field: "market", message: "A market is required." });
    assert.deepEqual(validateMarket({ market: "   " }), { field: "market", message: "A market is required." });
  });

  test("a market alone is valid — MLS and area are optional", () => {
    assert.equal(validateMarket({ market: "Boston" }), null);
  });

  test("refuses a row the client already covers, and names it", () => {
    const existing = [row("1", "Boston", "MLS PIN")];
    const problem = validateMarket({ market: "boston", mls: "mls pin" }, existing);
    assert.equal(problem?.field, "row");
    // The message must name the clashing row: a bare "duplicate" leaves the
    // user hunting for which of their rows it means.
    assert.match(problem!.message, /Boston · MLS PIN/);
  });

  test("the same market with a DIFFERENT MLS is allowed", () => {
    // The whole point of the table: one client, many markets and MLSes.
    assert.equal(validateMarket({ market: "Boston", mls: "MLS Other" }, [row("1", "Boston", "MLS PIN")]), null);
  });

  test("editing a row does not collide with itself", () => {
    const existing = [row("1", "Boston", "MLS PIN")];
    assert.equal(validateMarket({ market: "Boston", mls: "MLS PIN" }, existing, "1"), null);
  });

  test("editing a row DOES collide with a different row", () => {
    const existing = [row("1", "Boston"), row("2", "Florida")];
    const problem = validateMarket({ market: "Florida" }, existing, "1");
    assert.equal(problem?.field, "row");
  });

  test("rejects over-long values, per field", () => {
    const long = "x".repeat(MARKET_MAX + 1);
    assert.equal(validateMarket({ market: long })?.field, "market");
    assert.equal(validateMarket({ market: "Boston", mls: long })?.field, "mls");
    assert.equal(validateMarket({ market: "Boston", area: long })?.field, "area");
  });

  test("accepts values exactly at the limit", () => {
    const max = "x".repeat(MARKET_MAX);
    assert.equal(validateMarket({ market: max }), null);
  });
});

describe("marketLabel", () => {
  test("joins the parts that are set", () => {
    assert.equal(marketLabel({ market: "Boston", mls: "MLS PIN", area: "Suffolk" }), "Boston · MLS PIN · Suffolk");
  });

  test("omits the parts that are not", () => {
    assert.equal(marketLabel({ market: "Boston" }), "Boston");
    assert.equal(marketLabel({ market: "Boston", area: "Suffolk" }), "Boston · Suffolk");
  });
});

describe("sortMarkets", () => {
  test("orders by market, then MLS, then area, ignoring case", () => {
    const sorted = sortMarkets([
      row("1", "florida", "B"),
      row("2", "Boston", "Z"),
      row("3", "Boston", "A"),
      row("4", "Florida", "A"),
    ]);
    assert.deepEqual(sorted.map((r) => r.id), ["3", "2", "4", "1"]);
  });

  test("does not mutate its input", () => {
    const input = [row("1", "Z"), row("2", "A")];
    sortMarkets(input);
    assert.deepEqual(input.map((r) => r.id), ["1", "2"]);
  });
});

describe("suggestionsFrom", () => {
  test("de-duplicates case-insensitively, keeping the first spelling", () => {
    const s = suggestionsFrom([
      { market: "Boston", mls: "MLS PIN" },
      { market: "boston", mls: "mls pin" },
      { market: "Florida", mls: null },
    ]);
    assert.deepEqual(s.markets, ["Boston", "Florida"]);
    assert.deepEqual(s.mlses, ["MLS PIN"]);
  });

  test("skips blanks and nulls entirely", () => {
    const s = suggestionsFrom([{ market: "Boston", mls: "", area: null }]);
    assert.deepEqual(s.mlses, []);
    assert.deepEqual(s.areas, []);
  });

  test("sorts case-insensitively", () => {
    const s = suggestionsFrom([{ market: "zebra" }, { market: "Apple" }]);
    assert.deepEqual(s.markets, ["Apple", "zebra"]);
  });
});
