import "server-only";

import { NextRequest } from "next/server";

import { ttlCache } from "@/lib/cache/ttl";
import { toISODate } from "./query-params.ts";
import { onAnalyticsDataChanged } from "./read-cache-bus";

/*
 * A GET handler, answered from a short cache.
 *
 * The Analytics screens and Home ask the same few questions over and over —
 * this week's KPIs, the 30-day series, the filter lists — and each answer is
 * one to two seconds of RPC. The numbers only move when the sync lands new
 * rows, so asking again inside a minute gets the same answer, slower.
 *
 * The key is the path plus EVERY query parameter (sorted) plus today's date,
 * so a filter change is a different question and always reaches the database;
 * only the identical question is answered from memory. Within `ttlMs` it is
 * served as is; after that, for up to `staleMs`, the last answer is served
 * at once while a fresh one is fetched behind it. Errors are never cached,
 * and a sync that lands new rows marks every answer out of date.
 *
 * Only for handlers that read nothing but their URL: the request passed on
 * carries no cookies or headers, which is why it may be shared between users.
 */
interface Answer { status: number; body: string; headers: [string, string][] }

class NotCached extends Error {
  readonly answer: Answer;
  constructor(answer: Answer) {
    super(`status ${answer.status}`);
    this.answer = answer;
  }
}

const KEPT_HEADERS = ["content-type", "cache-control"];

export function cachedGet(
  handler: (request: NextRequest) => Promise<Response>,
  { ttlMs = 60_000, staleMs = 5 * 60_000 }: { ttlMs?: number; staleMs?: number } = {},
) {
  const read = ttlCache(
    async (_key: string, url: string): Promise<Answer> => {
      const res = await handler(new NextRequest(url));
      const answer: Answer = {
        status: res.status,
        body: await res.text(),
        headers: KEPT_HEADERS.flatMap((h) => {
          const v = res.headers.get(h);
          return v ? [[h, v] as [string, string]] : [];
        }),
      };
      if (!res.ok) throw new NotCached(answer);
      return answer;
    },
    { ttlMs, staleMs, key: (key) => key },
  );
  // A sync that lands new rows marks every answer out of date (read-cache-bus.ts):
  // the next reader still gets one at once, and a fresh one is fetched behind it.
  onAnalyticsDataChanged(() => read.expire());

  return async function GET(request: NextRequest): Promise<Response> {
    const url = request.nextUrl;
    const params = new URLSearchParams(url.searchParams);
    params.sort();
    const key = `${url.pathname}?${params.toString()}|${toISODate(new Date())}`;
    let answer: Answer;
    try {
      answer = await read(key, url.toString());
    } catch (e) {
      if (e instanceof NotCached) answer = e.answer;
      else throw e;
    }
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
}
