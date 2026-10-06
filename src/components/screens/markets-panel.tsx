"use client";

import { useCallback, useEffect, useState } from "react";

import { cleanList, type Coverage } from "@/lib/clients/coverage";

/*
 * A client's Markets, MLS and Area — edited here, in the OS, the way the
 * client data sheet records them (30 Sep):
 *
 *   Markets  how many markets the client covers — a number
 *   MLS      the MLS boards — a list of codes
 *   Area     the areas — a list of names
 *
 * Three independent facts. The earlier form paired each market with one MLS
 * and one area, which the business does not do: ChuckTown covers 6 markets
 * across 7 areas and 5 boards, and the sheet says exactly that.
 *
 * Markets are still NOT tied to a portal (the client's decision, 0017).
 *
 * THE INPUTS DO NOT USE `.inp` — its 200px min-width overflows this panel
 * inside a dialog. `.mk-inp` is the same look without the floor.
 */

interface Payload {
  coverage: Coverage;
  boards: { code: string; label: string }[];
  suggestions: { areas: string[] };
  leadBuilding: { codes: string[]; unknown: string[] } | null;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function ListField({ label, values, onChange, placeholder, listId, disabled }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; listId: string; disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    // A comma-separated paste adds several at once, as the sheet writes them.
    const next = cleanList([...values, ...draft.split(",")]);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="mk-field">
      <span className="mk-label">{label}</span>
      <div className="ds-multi">
        {values.length === 0 ? <span className="ds-multi-empty">None recorded.</span> : null}
        {values.map((v) => (
          <span key={v} className="ds-chip on">
            {v}
            <button type="button" className="mk-x" aria-label={`Remove ${v}`} disabled={disabled}
              onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
      </div>
      <div className="mk-form">
        <input className="mk-inp" list={listId} placeholder={placeholder} aria-label={`Add ${label}`} value={draft} disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); add(); } }} />
        <button type="button" className="mk-btn" disabled={disabled || !draft.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

export function MarketsPanel({ clientId, onChanged }: { clientId: string; onChanged?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [markets, setMarkets] = useState("");
  const [mls, setMls] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/clients/markets?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const p = body as Payload;
      setData(p);
      setMarkets(p.coverage.markets === null ? "" : String(p.coverage.markets));
      setMls(p.coverage.mls);
      setAreas(p.coverage.areas);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load markets");
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  if (loadError) return <p className="cd-empty">Could not load markets — {loadError}</p>;
  if (!data) return <p className="mut">Loading markets…</p>;

  const c = data.coverage;
  const changed = markets !== (c.markets === null ? "" : String(c.markets)) || !same(mls, c.mls) || !same(areas, c.areas);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const body: Record<string, unknown> = { clientId };
      if (markets !== (c.markets === null ? "" : String(c.markets))) body.markets = markets.trim() === "" ? null : Number(markets);
      if (!same(mls, c.mls)) body.mls = mls;
      if (!same(areas, c.areas)) body.areas = areas;
      const res = await fetch("/api/workspace/clients/markets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      await load();
      setSaved(true);
      // The list's Markets / MLS / Area columns and the tab's count follow (6 Oct).
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk">
      <datalist id="mk-mlses">
        {data.boards.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
      </datalist>
      <datalist id="mk-areas">{data.suggestions.areas.map((v) => <option key={v} value={v} />)}</datalist>

      <div className="mk-field">
        <span className="mk-label">Markets</span>
        <input className="mk-inp mk-num" inputMode="numeric" placeholder="How many" aria-label="Markets" value={markets} disabled={busy}
          onChange={(e) => setMarkets(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
      </div>
      <ListField label="MLS" values={mls} onChange={setMls} placeholder="Add an MLS board, e.g. BRIGHT" listId="mk-mlses" disabled={busy} />
      <ListField label="Area" values={areas} onChange={setAreas} placeholder="Add an area, e.g. greater Richmond" listId="mk-areas" disabled={busy} />

      {/* What the lead builder pulls agents from: the MLS codes the Database knows. */}
      {c.mls.length && data.leadBuilding ? (
        <p className="mk-lead">
          Lead building uses: {data.leadBuilding.codes.length ? <b>{data.leadBuilding.codes.join(", ")}</b> : <em>no known MLS board yet</em>}
          {data.leadBuilding.unknown.length ? (
            <span className="mk-warn"> · not an MLS board the Database knows, so skipped: {data.leadBuilding.unknown.join(", ")}.</span>
          ) : null}
        </p>
      ) : null}

      <div className="mk-form">
        <button type="button" className="btn" disabled={busy || !changed} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        {changed && !busy ? (
          <button type="button" className="mk-btn" onClick={() => { setMarkets(c.markets === null ? "" : String(c.markets)); setMls(c.mls); setAreas(c.areas); setError(null); }}>Cancel</button>
        ) : null}
        {saved && !changed ? <span className="mk-lead" style={{ margin: 0 }}>Saved.</span> : null}
      </div>
      {error ? <p className="mk-err" role="alert">{error}</p> : null}
    </div>
  );
}
