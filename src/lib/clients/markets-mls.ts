/*
 * A CLIENT'S MLS BOARDS: ONE LIST, TWO USES.
 *
 * The master record's Markets (market · MLS · area, many per client) and the
 * Database row's `orch_clients.mls` described the same thing and had separate
 * editors — the Clients page and the Onboarding page. §15: no field editable
 * in two places. They are not interchangeable in use, though:
 *
 *   Markets            what the client covers, as people describe it
 *   orch_clients.mls   comma-separated board CODES the lead builder pulls
 *                      agents from; "build leads" refuses without it, and
 *                      campaign names carry it
 *
 * So Markets is the one editor and the codes are DERIVED from it: every
 * market's MLS that is a real board in the `mls` table, in the board's own
 * spelling. An MLS typed that matches no board is reported, not sent — a code
 * the builder cannot resolve builds an empty lead list in silence.
 *
 * The one move the other way: a client whose intake form named boards arrives
 * with codes and no Markets. When onboarding links it, those codes SEED its
 * Markets (seedFromCodes), so nothing entered at intake is lost.
 *
 * Pure; tested in markets-mls.test.ts. On 28 Sep both sides were empty for all
 * 50 clients, so there was nothing to reconcile.
 */

export interface Board {
  code: string;
  name: string | null;
  state: string | null;
}

export interface MarketLike {
  market: string;
  mls: string | null;
}

export interface Derived {
  /** Board codes for orch_clients.mls, in the boards' own spelling, first mention first. */
  codes: string[];
  /** MLS values typed on a market that match no board — shown so someone can fix them. */
  unknown: string[];
}

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function deriveCodes(markets: MarketLike[], boards: Board[]): Derived {
  const byCode = new Map(boards.map((b) => [key(b.code), b.code.trim()]));
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const m of markets) {
    const raw = (m.mls ?? "").trim();
    if (!raw) continue;
    const hit = byCode.get(key(raw));
    if (hit) { if (!codes.includes(hit)) codes.push(hit); }
    else if (!unknown.some((u) => key(u) === key(raw))) unknown.push(raw);
  }
  return { codes, unknown };
}

/** The stored form of orch_clients.mls — what setClientMls has always written. */
export const codesToColumn = (codes: string[]): string | null => (codes.length ? codes.join(", ") : null);

/** The column read back, in the same split the Onboarding page uses (mlsCodes). */
export const columnToCodes = (col: string | null | undefined): string[] =>
  (col ?? "").split(",").map((c) => c.trim()).filter(Boolean);

/**
 * Markets to create from intake codes. The board's name stands in for the
 * market until someone describes it better; the code is the MLS.
 */
export function seedFromCodes(codes: string[], boards: Board[]): { market: string; mls: string; area: null }[] {
  const byCode = new Map(boards.map((b) => [key(b.code), b]));
  const out: { market: string; mls: string; area: null }[] = [];
  for (const c of codes) {
    const b = byCode.get(key(c));
    const mls = b ? b.code.trim() : c.trim();
    if (!mls || out.some((o) => key(o.mls) === key(mls))) continue;
    out.push({ market: (b?.name ?? "").trim() || mls, mls, area: null });
  }
  return out;
}
