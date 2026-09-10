/*
 * baseline.ts — the MLS monitor's diff, and the shapes it works on.
 *
 * Separate from courted-state.ts because BOTH sides need it: the server reads
 * the scheduler's baseline out of Supabase, and the browser holds its own in
 * localStorage. courted-state.ts is `server-only`, so anything a client
 * component touches has to live here or it drags the Supabase client into the
 * bundle.
 *
 * `indexScan` and `diffAccount` are verbatim from the tool — app.js's
 * `indexScan` and mls-monitor.js's `diffAccount` respectively.
 */

export interface MlsEntry {
  code: string;
  name: string;
  /** Display name with CTD_ buckets relabelled — see format.mlsDisplayName. */
  label: string;
  count: number | null;
}

/** One account as the live scan job reports it. Mirrors mls-scan.js's shape. */
export interface ScannedAccount {
  email: string;
  total?: number;
  mls?: { code: string; name?: string | null; count?: number | null }[];
  error?: string;
}

/** { email: { total, codes: { code: {name, count} } } } — the tool's own shape. */
export type BaselineIndex = Record<
  string,
  { total: number; codes: Record<string, { name: string; count: number }> }
>;

export interface StoredBaseline {
  savedAt: number;
  accounts: BaselineIndex;
}

/*
 * The tool's localStorage key. Kept EXACTLY as it is so a baseline saved by
 * search.brokerstaffer.com is still readable here — same origin is not the
 * case, so this will rarely matter in practice, but changing the key would
 * guarantee it never can.
 */
export const BASELINE_KEY = "mlsBaseline_v1";

/**
 * Index a completed scan for diffing.
 *
 * Verbatim from app.js. The `if (a.error) continue` is the important line: an
 * account that failed to log in has no MLS list, and baselining that empty
 * list would report every one of its MLSs as "removed" on the next scan — a
 * stale password would masquerade as losing access to six boards.
 */
export function indexScan(accounts: ScannedAccount[] | undefined | null): BaselineIndex {
  const out: BaselineIndex = {};
  for (const a of accounts || []) {
    if (a.error) continue;
    const codes: Record<string, { name: string; count: number }> = {};
    for (const m of a.mls || []) codes[m.code] = { name: m.name ?? "", count: m.count ?? 0 };
    out[a.email] = { total: a.total || 0, codes };
  }
  return out;
}

export interface AccountDiff {
  hadBaseline: boolean;
  added: string[];
  removed: string[];
  changed: boolean;
}

/** Which MLS codes appeared or disappeared. Verbatim from mls-monitor.js. */
export function diffAccount(
  baseCodes: Record<string, { name: string; count: number }> | null | undefined,
  mls: { code: string }[] | undefined | null,
): AccountDiff {
  const before = new Set(Object.keys(baseCodes || {}));
  const after = new Set((mls || []).map((m) => m.code));
  const added = [...after].filter((c) => !before.has(c));
  const removed = [...before].filter((c) => !after.has(c));
  return {
    hadBaseline: Boolean(baseCodes),
    added,
    removed,
    changed: Boolean(baseCodes) && (added.length > 0 || removed.length > 0),
  };
}

/** Read the browser baseline. Never throws — private mode, cleared data, junk. */
export function loadStoredBaseline(): StoredBaseline | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBaseline;
    return parsed && typeof parsed === "object" && parsed.accounts ? parsed : null;
  } catch {
    return null;
  }
}

/** Save the browser baseline. Returns false when storage refused. */
export function saveStoredBaseline(accounts: ScannedAccount[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify({ savedAt: Date.now(), accounts: indexScan(accounts) }));
    return true;
  } catch {
    return false;
  }
}
