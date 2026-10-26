"use client";

import { useEffect, useState } from "react";

import { campaignStatusWord } from "@/lib/clients/campaign-lists/rules";

/*
 * Client record → Campaigns: the client's Prospects campaign, pre-selected
 * until someone picks one (27 Oct). Admins only — the route answers 401/403
 * for everyone else and this renders nothing.
 *
 * The My Agents / DNC clean-up that shared this card is retired (27 Oct, the
 * user: "we do not have to remove the lead from campaigns. blacklisting and
 * unsubscribing is enough") — a portal's My Agents and DNC adds block the
 * address, and DNC unsubscribes the person, as before.
 */

type Campaign = { id: string; name: string; status: string };
type View =
  | { available: false }
  | {
      available: true;
      client: { prospectsCampaignId: string | null; prospectsCampaignName: string | null; updatedAt: string | null; updatedBy: string | null };
      campaigns: Campaign[];
      campaignsError: string | null;
      prospects: { suggested: Campaign | null; effective: Campaign | null; source: "chosen" | "suggested" | "none"; savedMissing: { id: string; name: string | null } | null };
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
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = async () => {
    const res = await fetch(url(clientId), { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    const v = body as View;
    setView(v);
    if (v.available) setPick(v.prospects.effective?.id ?? "");
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
  return (
    <section className="rx-sec" id="rx-campaign-lists">
      <h3>Prospects campaign<span>admins only</span></h3>

      <div className="cl-card" data-testid="cl-prospects">
        <div className="cl-head">
          <b>Where new Prospects go</b>
          {p.source === "chosen" ? <span className="rb-pill good">Chosen</span> : p.source === "suggested" ? <span className="rb-pill mute" title="The client's newest sending campaign — used until someone picks another">Pre-selected</span> : null}
        </div>
        <p className="rx-hint cl-hint">New Prospects go to this EmailBison campaign. Adding them automatically is not switched on yet.</p>
        {view.campaignsError ? (
          <p className="rx-hint cl-bad">This client&apos;s campaigns could not be read just now: {view.campaignsError}</p>
        ) : !view.campaigns.length ? (
          <p className="rx-hint">This client has no EmailBison campaigns yet — one is pre-selected as soon as it has one.</p>
        ) : (
          <div className="cl-pick">
            <select id="rx-prospects-campaign" aria-label="Prospects campaign" className="ds-input" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
              {GROUPS.map((g) => {
                const list = view.campaigns.filter((c) => g.statuses.includes(c.status));
                return list.length ? (
                  <optgroup key={g.label} label={g.label}>
                    {list.map((c) => <option key={c.id} value={c.id}>{c.name}{p.suggested?.id === c.id ? "  · pre-selected" : ""}</option>)}
                  </optgroup>
                ) : null;
              })}
              {finished.length ? (
                <optgroup label="Finished">
                  {finished.map((c) => <option key={c.id} value={c.id}>{c.name} ({campaignStatusWord(c.status)})</option>)}
                </optgroup>
              ) : null}
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
