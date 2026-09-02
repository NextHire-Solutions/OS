import type { HttpResult } from "@/lib/connectors/types";

const UA = "brokerstaffer-command-center/1.0 (+status-probe)";

/** Cap the read. A login page is ~40KB and a client roster ~200KB, but a
 *  misconfigured URL could otherwise stream forever into our event loop. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * One fetch, fully instrumented and incapable of throwing.
 *
 * `redirect: "manual"` is deliberate: server-side undici hands back the real
 * 3xx plus its Location header instead of an opaque response. A 307 to /login
 * PROVES the app is serving — following it would cost a second round trip and
 * tell us strictly less.
 */
export async function httpProbe(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: "GET" | "HEAD";
  } = {},
): Promise<HttpResult> {
  const { timeoutMs = 5_000, headers = {}, method = "GET" } = opts;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept: "application/json, text/html;q=0.8",
        ...headers,
      },
    });

    const latencyMs = Math.round(performance.now() - started);
    const contentType = res.headers.get("content-type") ?? "";

    let bodyText: string | null = null;
    let json: unknown = null;

    if (method !== "HEAD") {
      bodyText = (await res.text()).slice(0, MAX_BODY_BYTES);
      if (contentType.includes("application/json")) {
        try {
          json = JSON.parse(bodyText);
        } catch {
          // Leave json null — classify() treats an unparseable JSON body as a
          // shape problem, which is `unknown`, not `down`.
        }
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      bodyText,
      json,
      failure: null,
      location: res.headers.get("location"),
    };
  } catch {
    const latencyMs = Math.round(performance.now() - started);
    return {
      ok: false,
      status: null,
      latencyMs,
      bodyText: null,
      json: null,
      failure: controller.signal.aborted ? "timeout" : "network",
      location: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
