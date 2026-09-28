"use client";

import { useCallback, useEffect, useState } from "react";

import { marketLabel, validateMarket, type MarketRow } from "@/lib/clients/markets";

/*
 * The markets a client covers — add, edit and delete, in the OS.
 *
 * The client asked for exactly this: "one client can cover multiple Markets, MLS
 * and Area hence have multiple campaigns and 1 or multiple portals", and "this is
 * something we need to be able to add/edit/delete on our own via the OS".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED THREE READ-ONLY ROWS
 *
 * The detail panel used to show Market, MLS and Area as three single values from
 * `os_clients`, because that is what migration 0015 gave it. Those columns could
 * hold one market per client, which cannot describe Properties & Estates
 * (Boston AND Florida). Migration 0017 moved them to their own table; this is
 * the surface for it.
 *
 * Markets are NOT tied to a portal here, deliberately — see migration 0017. So
 * this panel never claims which portal serves which market, because nothing
 * knows that yet.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION RUNS HERE AND ON THE SERVER, FROM ONE MODULE
 *
 * `validateMarket` is imported by both this component and the route. The point
 * is not to save a round trip — it is that a duplicate says "This client
 * already covers Boston · MLS PIN" in both places, instead of a friendly
 * message locally and a constraint violation from the server.
 *
 * ---------------------------------------------------------------------------
 * THE INPUTS DO NOT USE `.inp`
 *
 * `.inp` carries a 200px min-width, which overflows a three-column grid inside
 * this dialog and pushes the buttons off the edge. `.mk-inp` is the same look
 * without the floor. This is the second time that min-width has broken a dialog
 * grid; it is scoped here rather than changed globally because the wide fields
 * elsewhere rely on it.
 */

interface Suggestions {
  markets: string[];
  mlses: string[];
  areas: string[];
}

const EMPTY_FORM = { market: "", mls: "", area: "" };
const NO_SUGGESTIONS: Suggestions = { markets: [], mlses: [], areas: [] };

export function MarketsPanel({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions>(NO_SUGGESTIONS);
  const [form, setForm] = useState(EMPTY_FORM);
  /** The row being edited, or null when the form is adding a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/clients/markets?clientId=${encodeURIComponent(clientId)}`, {
        cache: "no-store",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRows(body.markets ?? []);
      setSuggestions(body.suggestions ?? NO_SUGGESTIONS);
      setLoadError(null);
    } catch (e) {
      // Distinct from a validation error: this one means we cannot show the
      // list at all, so the form is hidden rather than left to submit blind.
      setLoadError(e instanceof Error ? e.message : "Could not load markets");
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  const reset = () => { setForm(EMPTY_FORM); setEditing(null); setError(null); };

  async function submit() {
    if (!rows) return;
    // The same rule the server applies, so the message is identical either way.
    const problem = validateMarket(form, rows, editing ?? undefined);
    if (problem) { setError(problem.message); return; }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/clients/markets", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...(editing ? { id: editing } : {}), ...form }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that market");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: MarketRow) {
    // Names the row exactly as the list does, via the shared `marketLabel`, so
    // the confirmation cannot describe a different row from the one clicked.
    if (!window.confirm(`Remove ${marketLabel(row)} from this client?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspace/clients/markets?clientId=${encodeURIComponent(clientId)}&id=${encodeURIComponent(row.id)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (editing === row.id) reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that market");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="cd-empty">Could not load markets — {loadError}</p>;
  if (!rows) return <p className="mut">Loading markets…</p>;

  return (
    <div className="mk">
      {rows.length === 0 ? (
        <p className="cd-empty">
          No markets recorded. A client may cover several — add each market, with its MLS and area.
        </p>
      ) : (
        <ul className="mk-list">
          {rows.map((r) => (
            <li key={r.id} className={editing === r.id ? "mk-item mk-editing" : "mk-item"}>
              <span className="mk-market">{r.market}</span>
              <span className="mk-sub">
                {r.mls ? r.mls : <em className="cd-empty">no MLS</em>}
                {" · "}
                {r.area ? r.area : <em className="cd-empty">no area</em>}
              </span>
              <span className="mk-acts">
                <button
                  className="mk-btn" disabled={busy}
                  onClick={() => { setEditing(r.id); setError(null);
                    setForm({ market: r.market, mls: r.mls ?? "", area: r.area ?? "" }); }}
                >
                  Edit
                </button>
                <button className="mk-btn mk-del" disabled={busy} onClick={() => void remove(r)}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mk-form">
        <datalist id="mk-markets">{suggestions.markets.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="mk-mlses">{suggestions.mlses.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="mk-areas">{suggestions.areas.map((v) => <option key={v} value={v} />)}</datalist>

        <input
          className="mk-inp" list="mk-markets" placeholder="Market (required)"
          aria-label="Market" value={form.market} disabled={busy}
          onChange={(e) => setForm({ ...form, market: e.target.value })}
        />
        <input
          className="mk-inp" list="mk-mlses" placeholder="MLS (optional)"
          aria-label="MLS" value={form.mls} disabled={busy}
          onChange={(e) => setForm({ ...form, mls: e.target.value })}
        />
        <input
          className="mk-inp" list="mk-areas" placeholder="Area (optional)"
          aria-label="Area" value={form.area} disabled={busy}
          onChange={(e) => setForm({ ...form, area: e.target.value })}
        />
        <button className="btn" disabled={busy || !form.market.trim()} onClick={() => void submit()}>
          {editing ? "Save" : "Add market"}
        </button>
        {editing ? <button className="mk-btn" disabled={busy} onClick={reset}>Cancel</button> : null}
      </div>

      {error ? <p className="mk-err" role="alert">{error}</p> : null}
    </div>
  );
}
