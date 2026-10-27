"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

export type PickOption = { value: string; label?: string };

/**
 * A list of values as chips inside one box, with a searchable list under it (28 Oct, the user: "can we make this ui
 * better"): type to search the options (an MLS board by code, name or state), arrow keys and Enter or a click to add,
 * Backspace to take the last one off. Something not in the options can still be added (Enter); `isKnown` marks it.
 * The Markets section and Onboard a client use it for the same MLS and Area lists. Classes are `mkp-` (workspace.css).
 */
export function ListField({ id, label, hint, values, onChange, placeholder, options, disabled, isKnown, addOnBlur = false, preferOptions = false }: {
  id: string; label: string; hint?: string; values: string[]; onChange: (v: string[]) => void; placeholder: string;
  options: PickOption[]; disabled: boolean; isKnown?: (v: string) => boolean;
  /** Typed text not picked from the list is added when the box is left (an area). */
  addOnBlur?: boolean;
  /** Enter takes the best match (an MLS board found by its name); otherwise Enter adds the text as typed (an area). */
  preferOptions?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  // Moved through the list with the arrow keys: Enter then takes the highlighted one.
  const [nav, setNav] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const q = draft.trim().toLowerCase();
  const taken = new Set(values.map((v) => v.toLowerCase()));
  // The code first when it starts with what was typed, then anything containing it; at most eight.
  const matches = options
    .filter((o) => !taken.has(o.value.toLowerCase()) && (!q || o.value.toLowerCase().includes(q) || (o.label ?? "").toLowerCase().includes(q)))
    .sort((a, b) => Number(!a.value.toLowerCase().startsWith(q)) - Number(!b.value.toLowerCase().startsWith(q)))
    .slice(0, 8);
  const add = (raw: string) => {
    // A comma-separated paste adds several at once, as the sheet writes them; an option keeps its own spelling.
    const named = raw.split(",").map((part) => options.find((o) => o.value.toLowerCase() === part.trim().toLowerCase())?.value ?? part);
    onChange(cleanList([...values, ...named]));
    setDraft("");
    setHi(0);
    setNav(false);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && matches.length) { e.preventDefault(); setOpen(true); setNav(true); setHi((h) => (nav ? Math.min(h + 1, matches.length - 1) : 0)); }
    else if (e.key === "ArrowUp" && matches.length) { e.preventDefault(); setNav(true); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const exact = options.find((o) => o.value.toLowerCase() === q);
      if (nav && matches[hi]) add(matches[hi].value);
      else if (exact) add(exact.value);
      else if (preferOptions && q && matches[0]) add(matches[0].value);
      else if (draft.trim()) add(draft);
    } else if (e.key === "Escape") { if (open) { e.stopPropagation(); setOpen(false); } }
    else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
  };
  const showList = open && !disabled && (matches.length > 0 || !!q);
  return (
    <div className="mkp">
      <label className="mkp-label" htmlFor={id}>{label}{hint ? <span className="mkp-hint">{hint}</span> : null}</label>
      <div className={`mkp-box${disabled ? " mkp-off" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        {values.map((v) => {
          const known = !isKnown || isKnown(v);
          return (
            <span key={v} className={known ? "mkp-chip" : "mkp-chip mkp-unknown"} title={known ? undefined : "Not a board we have agents for — it brings no one"}>
              {v}
              <button type="button" aria-label={`Remove ${v}`} disabled={disabled} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
            </span>
          );
        })}
        <input
          ref={input} id={id} className="mkp-in" aria-label={`Add ${label}`} placeholder={values.length ? "Add another…" : placeholder}
          value={draft} disabled={disabled} autoComplete="off"
          role="combobox" aria-expanded={showList} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={showList && nav && matches[hi] ? `${id}-o${hi}` : undefined}
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); if (addOnBlur && draft.trim()) add(draft); }}
          onChange={(e) => { setDraft(e.target.value); setOpen(true); setHi(0); setNav(false); }}
          onKeyDown={onKey}
        />
      </div>
      {showList ? (
        <ul className="mkp-list" role="listbox" id={`${id}-list`} aria-label={label}>
          {matches.map((o, i) => (
            <li key={o.value} id={`${id}-o${i}`} role="option" aria-selected={nav && i === hi} className={nav && i === hi ? "mkp-opt mkp-hi" : "mkp-opt"}
              onMouseDown={(e) => { e.preventDefault(); add(o.value); }} onMouseEnter={() => { setHi(i); setNav(true); }}>
              <b>{o.value}</b>{o.label ? <span>{o.label}</span> : null}
            </li>
          ))}
          {q && !options.some((o) => o.value.toLowerCase() === q) ? (
            <li className="mkp-opt mkp-free" onMouseDown={(e) => { e.preventDefault(); add(draft); }}>
              Add &ldquo;{draft.trim()}&rdquo;{isKnown && !isKnown(draft.trim()) ? <span>not a board we have agents for</span> : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * How many salespeople these MLS boards bring — the market the client's new portal shows — counted as the list
 * changes (the markets route's ?size=, the portal's own rule). `none`: what to say with no board at all.
 */
export function MarketSize({ codes, none }: { codes: string[]; none: string }) {
  const [s, setS] = useState<{ state: "counting" | "done" | "error"; total?: number; matched?: string[]; unmatched?: string[] }>({ state: "counting" });
  const key = codes.join(",");
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    setS({ state: "counting" });
    const t = setTimeout(() => {
      fetch(`/api/workspace/clients/markets?size=${encodeURIComponent(key)}`, { signal: ctrl.signal, cache: "no-store" })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
          setS({ state: "done", total: Number(j.total) || 0, matched: (j.matched ?? []).map((m: { code: string }) => m.code), unmatched: j.unmatched ?? [] });
        })
        .catch((e) => { if (e?.name !== "AbortError") setS({ state: "error" }); });
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [key]);
  if (!key) return <p className="mkp-note mkp-warn">{none}</p>;
  if (s.state === "counting") return <p className="mkp-note" role="status">Counting the salespeople on {codes.join(", ")}…</p>;
  if (s.state === "error") return <p className="mkp-note">Couldn&rsquo;t count the market just now — the boards save either way.</p>;
  return (
    <p className="mkp-note" role="status" data-market-size={s.total}>
      {s.total ? <><b>{s.total.toLocaleString("en-US")}</b> salespeople on {s.matched?.join(", ")} — the market their portal shows.</> : <>No salespeople on {codes.length === 1 ? "this board" : "these boards"} in our agent database.</>}
      {s.unmatched?.length ? <span className="mkp-warn"> Not a board we have agents for: {s.unmatched.join(", ")}.</span> : null}
    </p>
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

  const boards = data.boards.map((b) => ({ value: b.code, label: b.label }));
  const known = (v: string) => !boards.length || boards.some((b) => b.value.toLowerCase() === v.toLowerCase());
  return (
    <div className="mk">
      <ListField id="mk-mls" label="MLS boards" values={mls} onChange={setMls} placeholder="Search boards — e.g. BRIGHT, Virginia" options={boards} isKnown={known} preferOptions disabled={busy} />
      <MarketSize codes={mls} none="No MLS board — their new portal shows no market until one is added." />
      <div className="mkp-row">
        <ListField id="mk-areas" label="Areas" hint="optional" values={areas} onChange={setAreas} placeholder="e.g. greater Richmond" options={data.suggestions.areas.map((v) => ({ value: v }))} addOnBlur disabled={busy} />
        <label className="mkp">
          <span className="mkp-label">Markets<span className="mkp-hint">optional</span></span>
          <input className="mkp-box mkp-num" inputMode="numeric" placeholder="How many" aria-label="Markets" value={markets} disabled={busy}
            onChange={(e) => setMarkets(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} />
        </label>
      </div>

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
