"use client";

import { useEffect, useState } from "react";

import { campaignStatusWord } from "@/lib/clients/campaign-lists/rules";

/*
 * Client record → Campaigns: the client's Prospects campaign, pre-selected
 * until someone picks one (27 Oct). Admins only — the route answers 401/403
 * for everyone else and this renders nothing. A client with several MLSs has a
 * campaign per market: one picked per MLS, never pre-selected (3 Nov) — an
 * agent goes into the campaign of its MLS (prospect-sync).
 *
 * The My Agents / DNC clean-up that shared this card is retired (27 Oct, the
 * user: "we do not have to remove the lead from campaigns. blacklisting and
 * unsubscribing is enough") — a portal's My Agents and DNC adds block the
 * address, and DNC unsubscribes the person, as before.
 */

type Campaign = { id: string; name: string; status: string };
type MlsRow = { code: string; name: string; picked: Campaign | null; savedMissing: { id: string; name: string } | null; setup: { id: string; name: string } | null };
type View =
  | { available: false }
  | {
      available: true;
      client: { prospectsCampaignId: string | null; prospectsCampaignName: string | null; updatedAt: string | null; updatedBy: string | null };
      campaigns: Campaign[];
      campaignsError: string | null;
      prospects: { suggested: Campaign | null; effective: Campaign | null; source: "chosen" | "suggested" | "none"; savedMissing: { id: string; name: string | null } | null };
      byMls?: { several: boolean; markets: MlsRow[] };
      marketsError?: string | null;
      autoAdd?: "off" | "test" | "live";
    };

/* What adding Prospects to the campaign does today — the switch is the OS's (prospect-sync). */
const AUTO_TEXT: Record<"off" | "test" | "live", string> = {
  off: "Adding them automatically is not switched on yet.",
  test: "Adding them automatically is being tried on a few portals first — not this client's yet.",
  live: "When the client adds an agent to Prospects, it goes into this campaign; taken off Prospects, it comes out of the client's campaigns.",
};

const url = (id: string) => `/api/tools/master-inbox/campaign-cleanup/client/${encodeURIComponent(id)}`;

/* The dropdown's groups, in the order the server already sorted them. */
const GROUPS: Array<{ label: string; statuses: string[] }> = [
  { label: "Sending", statuses: ["active"] },
  { label: "About to send", statuses: ["launching", "queued"] },
  { label: "Paused", statuses: ["paused"] },
  { label: "Drafts", statuses: ["draft"] },
];

export function ClientCampaignLists({ clientId }: { clientId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = async () => {
    const res = await fetch(url(clientId), { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    const v = body as View;
    setView(v);
    if (v.available) {
      setPick(v.prospects.effective?.id ?? "");
      setPicks(Object.fromEntries((v.byMls?.markets ?? []).map((m) => [m.code, m.picked?.id ?? ""])));
    }
  };
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [clientId]);

  if (error) {
    return (
      <section className="rx-sec" id="rx-campaign-lists">
        <h3>Prospects campaign</h3>
        <p className="rx-hint" style={{ color: "var(--x-bad, #b42318)" }}>{error}</p>
      </section>
    );
  }
  if (!view) return null;
  if (!view.available) {
    return (
      <section className="rx-sec" id="rx-campaign-lists">
        <h3>Prospects campaign</h3>
        <p className="rx-hint">Needs migration 0042_campaign_lists.sql run in the Master Inbox Supabase project.</p>
      </section>
    );
  }

  const save = async (patch: Record<string, unknown>, done: string) => {
    setBusy(true);
    setNote(null);
    const res = await fetch(url(clientId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...patch, ifUpdatedAt: view.client.updatedAt }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setNote({ text: body?.error ?? `Could not save (${res.status})`, bad: true });
    setNote({ text: done });
    await load().catch(() => {});
  };

  const p = view.prospects;
  const chosenId = p.source === "chosen" ? p.effective?.id ?? "" : "";
  const nameOf = (id: string) => view.campaigns.find((c) => c.id === id)?.name ?? id;
  // Save only lights up for a change: the pre-selected campaign is already the one in use.
  const dirty = pick !== "" && pick !== (p.effective?.id ?? "");
  const finished = view.campaigns.filter((c) => !GROUPS.some((g) => g.statuses.includes(c.status)));
  const options = (suggested: string | null) => (
    <>
      {GROUPS.map((g) => {
        const list = view.campaigns.filter((c) => g.statuses.includes(c.status));
        return list.length ? (
          <optgroup key={g.label} label={g.label}>
            {list.map((c) => <option key={c.id} value={c.id}>{c.name}{suggested === c.id ? "  · pre-selected" : ""}</option>)}
          </optgroup>
        ) : null;
      })}
      {finished.length ? (
        <optgroup label="Finished">
          {finished.map((c) => <option key={c.id} value={c.id}>{c.name} ({campaignStatusWord(c.status)})</option>)}
        </optgroup>
      ) : null}
    </>
  );
  const auto = AUTO_TEXT[view.autoAdd ?? "off"];

  if (view.byMls?.several) {
    const rows = view.byMls.markets;
    const changed = rows.filter((m) => (picks[m.code] ?? "") !== (m.picked?.id ?? ""));
    return (
      <section className="rx-sec" id="rx-campaign-lists">
        <h3>Prospects campaigns<span>admins only</span></h3>
        <div className="cl-card" data-testid="cl-prospects-mls">
          <div className="cl-head"><b>Where new Prospects go, by MLS</b></div>
          <p className="rx-hint cl-hint">
            This client has several markets: an agent added to Prospects goes into the campaign picked for its MLS (one
            campaign can take several). An MLS with none picked: its new Prospects wait, and the bell asks. {auto}
          </p>
          {view.campaignsError ? <p className="rx-hint cl-bad">This client&apos;s campaigns could not be read just now: {view.campaignsError}</p> : null}
          {rows.map((m) => (
            <div className="cl-mls" key={m.code} data-testid={`cl-mls-${m.code}`}>
              <label className="cl-mls-name" htmlFor={`rx-prospects-mls-${m.code}`}><b>{m.code}</b> <span>{m.name}</span></label>
              <div className="cl-pick">
                <select id={`rx-prospects-mls-${m.code}`} aria-label={`Prospects campaign for ${m.code}`} className="ds-input" value={picks[m.code] ?? ""} disabled={busy || !!view.campaignsError}
                  onChange={(e) => setPicks({ ...picks, [m.code]: e.target.value })}>
                  <option value="">Not picked</option>
                  {options(null)}
                </select>
              </div>
              {m.picked ? (
                <p className="rx-hint cl-meta"><span className="cl-dot" data-s={m.picked.status} aria-hidden="true" />{campaignStatusWord(m.picked.status)} · EmailBison #{m.picked.id}</p>
              ) : m.setup ? (
                <p className="rx-hint cl-meta">Made at setup: {m.setup.name} (EmailBison #{m.setup.id}) — used until one is picked.</p>
              ) : (
                <p className="rx-hint cl-meta">Not picked — this MLS&apos;s new Prospects wait.</p>
              )}
              {m.savedMissing ? <p className="rx-hint cl-bad">The campaign picked earlier ({m.savedMissing.name}) is no longer one of this client&apos;s — pick again.</p> : null}
            </div>
          ))}
          <div className="cl-pick">
            <button type="button" className="rx-btn solid" disabled={!changed.length || busy || !!view.campaignsError}
              onClick={() => void save(
                { prospectsByMls: Object.fromEntries(changed.map((m) => [m.code, picks[m.code] || null])) },
                changed.map((m) => (picks[m.code] ? `${m.code} → ${nameOf(picks[m.code])}` : `${m.code}: not picked`)).join(" · ") + ".",
              )}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        {note ? <p className="rx-hint" role="status" style={note.bad ? { color: "var(--x-bad, #b42318)" } : undefined}>{note.text}</p> : null}
      </section>
    );
  }

  return (
    <section className="rx-sec" id="rx-campaign-lists">
      <h3>Prospects campaign<span>admins only</span></h3>

      <div className="cl-card" data-testid="cl-prospects">
        <div className="cl-head">
          <b>Where new Prospects go</b>
          {p.source === "chosen" ? <span className="rb-pill good">Chosen</span> : p.source === "suggested" ? <span className="rb-pill mute" title="The client's newest sending campaign — used until someone picks another">Pre-selected</span> : null}
        </div>
        <p className="rx-hint cl-hint">New Prospects go to this EmailBison campaign. {auto}</p>
        {view.campaignsError ? (
          <p className="rx-hint cl-bad">This client&apos;s campaigns could not be read just now: {view.campaignsError}</p>
        ) : !view.campaigns.length ? (
          <p className="rx-hint">This client has no EmailBison campaigns yet — one is pre-selected as soon as it has one.</p>
        ) : (
          <div className="cl-pick">
            <select id="rx-prospects-campaign" aria-label="Prospects campaign" className="ds-input" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
              {options(p.suggested?.id ?? null)}
            </select>
            <button type="button" className="rx-btn solid" disabled={!dirty || busy}
              onClick={() => void save({ prospectsCampaignId: pick }, `Prospects will go to ${nameOf(pick)}.`)}>
              {busy ? "Saving…" : "Save"}
            </button>
            {p.source === "chosen" && p.suggested && p.suggested.id !== chosenId ? (
              <button type="button" className="rx-btn" disabled={busy}
                onClick={() => void save({ prospectsCampaignId: null }, `Back to the pre-selected campaign, ${p.suggested!.name}.`)}>
                Use pre-selected
              </button>
            ) : null}
          </div>
        )}
        {p.effective ? (
          <p className="rx-hint cl-meta">
            <span className="cl-dot" data-s={p.effective.status} aria-hidden="true" />
            {campaignStatusWord(p.effective.status)} · EmailBison #{p.effective.id}
            {p.source === "chosen" && view.client.updatedBy ? ` · chosen by ${view.client.updatedBy}` : ""}
          </p>
        ) : null}
        {p.savedMissing ? (
          <p className="rx-hint cl-bad">The campaign chosen earlier ({p.savedMissing.name ?? `#${p.savedMissing.id}`}) no longer exists — the pre-selected one is used instead.</p>
        ) : null}
      </div>

      {note ? <p className="rx-hint" role="status" style={note.bad ? { color: "var(--x-bad, #b42318)" } : undefined}>{note.text}</p> : null}
    </section>
  );
}
