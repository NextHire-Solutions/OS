/*
 * Reading a whole EmailBison list — both ways it pages.
 *
 * Most index routes page by CURSOR. /api/campaigns/sending-schedules ignores
 * that and pages by NUMBER, and until 13 Oct the walk stopped after its first
 * page: the Schedule screen listed 15 campaigns when 24 were sending. These
 * run the real client against a scripted `fetch`.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { EmailBisonClient } from "./client.ts";

type Page = { data: unknown[]; meta?: Record<string, unknown> };
const calls: string[] = [];
let answer: (url: URL) => Page = () => ({ data: [] });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
mock.method(console, "warn", () => {});

const client = new EmailBisonClient({ baseUrl: "http://emailbison.test", apiKey: "k" });
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ campaign_id: from + i, emails_being_sent: 10 }));

test("a list that pages by NUMBER is read to its last page (the Schedule's 24 campaigns, not 15)", async () => {
  calls.length = 0;
  answer = (url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return { data: page === 1 ? rows(1, 15) : page === 2 ? rows(16, 9) : [], meta: { current_page: page, last_page: 2, per_page: 15, total: 24 } };
  };
  const all = await client.getAllSendingSchedules("today");
  assert.equal(all.length, 24);
  assert.deepEqual(all.map((r) => r.campaign_id), Array.from({ length: 24 }, (_, i) => i + 1), "every campaign once, in order");
  assert.equal(calls.length, 2, "two pages, two requests — not a third to find out there is none");
  assert.match(calls[0], /day=today/);
  assert.match(calls[1], /day=today&page=2|page=2&day=today/);
});

test("three numbered pages", async () => {
  calls.length = 0;
  answer = (url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return { data: rows((page - 1) * 15 + 1, page === 3 ? 4 : 15), meta: { current_page: page, last_page: 3 } };
  };
  assert.equal((await client.getAllSendingSchedules("tomorrow")).length, 34);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.includes("day=tomorrow")), "the filter rides along on every page");
});

test("a single numbered page makes one request", async () => {
  calls.length = 0;
  answer = () => ({ data: rows(1, 7), meta: { current_page: 1, last_page: 1 } });
  assert.equal((await client.getAllSendingSchedules()).length, 7);
  assert.equal(calls.length, 1);
});

test("a CURSOR list is still read by cursor, to its null marker — and never switches to page numbers", async () => {
  calls.length = 0;
  answer = (url) => {
    const c = url.searchParams.get("cursor");
    if (!c) return { data: rows(1, 15), meta: { next_cursor: "c2", prev_cursor: null } };
    if (c === "c2") return { data: rows(16, 15), meta: { next_cursor: "c3", prev_cursor: "c1" } };
    return { data: rows(31, 3), meta: { next_cursor: null, prev_cursor: "c2" } };
  };
  const all = await client.getAllSendingSchedules();
  assert.equal(all.length, 33);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => !/[?&]page=/.test(c)), "no page numbers on a cursor walk");
});

test("a cursor list whose first page is also its last (next_cursor: null) is not mistaken for a numbered one", async () => {
  calls.length = 0;
  // Some cursor responses carry page-ish fields too; the null cursor is what says "the end".
  answer = () => ({ data: rows(1, 5), meta: { next_cursor: null, current_page: 1, last_page: 9 } });
  assert.equal((await client.getAllSendingSchedules()).length, 5);
  assert.equal(calls.length, 1);
});

test("a numbered list that shrinks while being read stops at the empty page", async () => {
  calls.length = 0;
  answer = (url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return { data: page === 1 ? rows(1, 15) : [], meta: { current_page: page, last_page: 4 } };
  };
  assert.equal((await client.getAllSendingSchedules()).length, 15);
  assert.equal(calls.length, 2);
});
