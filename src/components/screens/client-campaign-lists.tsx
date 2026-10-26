"use client";

import { useEffect, useState } from "react";

import { campaignStatusWord, removalLine, SOURCE_LABEL, type RemovalStatus } from "@/lib/clients/campaign-lists/rules";
import type { RemovalRow } from "@/lib/clients/campaign-lists/sweep";

/*
 * Client record → Campaigns: the client's Prospects campaign (pre-selected
 * until someone picks one, 27 Oct) and its own switch for the My Agents / DNC
 * clean-up (lib/clients/campaign-lists/). Admins only — the route answers
 * 401/403 for everyone else and this renders nothing.
 */

type Campaign = { id: string; name: string; status: string };
type View =
  | { available: false }
  | {
      available: true;
      global: { enabled: boolean; practiceMode: boolean };
      server: { liveAllowed: boolean };
      client: { removeEnabled: boolean; prospectsCampaignId: string | null; prospectsCampaignName: string | null; updatedAt: string | null; updatedBy: string | null };
      campaigns: Campaign[];
      campaignsError: string | null;
      prospects: { suggested: Campaign | null; effective: Campaign | null; source: "chosen" | "suggested" | "none"; savedMissing: { id: string; name: string | null } | null };
      recent: RemovalRow[];
    };
type Ready = Extract<View, { available: true }>;

const url = (id: string) => `/api/tools/master-inbox/campaign-cleanup/client/${encodeURIComponent(id)}`;

/* The dropdown's groups, in the order the server already sorted them. */
const GROUPS: Array<{ label: string; statuses: string[] }> = [
  { label: "Sending", statuses: ["active"] },
  { label: "About to send", statuses: ["launching", "queued"] },
  { label: "Paused", statuses: ["paused"] },
  { label: "Drafts", statuses: ["draft"] },
];

const ENTRY_TONE: Record<RemovalStatus, "good" | "warn" | "bad" | "mute"> = {
  removed: "good", partly_removed: "warn", failed: "bad", practice: "warn", pending: "mute", skipped: "mute", not_in_campaigns: "mute",
};
const ENTRY_WORD: Record<RemovalStatus, string> = {
  removed: "Removed", partly_removed: "Partly removed", failed: "Failed", practice: "Practice", pending: "Looking up", skipped: "Skipped", not_in_campaigns: "On none",
};

function cleanupState(v: Ready): { label: string; tone: "good" | "warn" | "mute"; text: string } {
  if (!v.global.enabled) return { label: "Off", tone: "mute", text: "The clean-up is off for every client (Inbox → Settings → Campaign clean-up)." };
  if (v.global.practiceMode) return { label: "Practice", tone: "warn", text: "Recording which of this client's campaigns new entries would come off. Nothing is removed." };
  if (!v.server.liveAllowed) return { label: "Practice", tone: "warn", text: "Settings allow removing, but the server's lock is closed — nothing is removed." };
  if (!v.client.removeEnabled) return { label: "Practice", tone: "warn", text: "Removing is on, but not for this client until its own switch is on." };
  return { label: "Live", tone: "good", text: "New My Agents and DNC entries come off this client's own EmailBison campaigns." };
}

export function ClientCampaignLists({ clientId }: { clientId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<null | "campaign" | "switch">(null);
  const [armed, setArmed] = useState(false);
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
        <h3>Prospects and list clean-up</h3>
        <p className="rx-hint" style={{ color: "var(--x-bad, #b42318)" }}>{error}</p>
      </section>
    );
  }
  if (!view) return null;
  if (!view.available) {
    return (
      <section className="rx-sec" id="rx-campaign-lists">
        <h3>Prospects and list clean-up</h3>
        <p className="rx-hint">Needs migration 0042_campaign_lists.sql run in the Master Inbox Supabase project.</p>
      </section>
    );
  }

  const save = async (patch: Record<string, unknown>, what: "campaign" | "switch", done: string) => {
    setBusy(what);
    setNote(null);
    const res = await fetch(url(clientId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...patch, ifUpdatedAt: view.client.updatedAt }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    setArmed(false);
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
  const state = cleanupState(view);
  const on = view.client.removeEnabled;
  const toggle = () => {
    if (on) return void save({ removeEnabled: false }, "switch", "This client's switch is off — its campaigns are no longer changed.");
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    void save({ removeEnabled: true }, "switch", "This client's switch is on.");
  };

  return (
    <section className="rx-sec" id="rx-campaign-lists">
      <h3>Prospects and list clean-up<span>admins only</span></h3>

      <div className="cl-card" data-testid="cl-prospects">
        <div className="cl-head">
          <b>Prospects campaign</b>
          {p.source === "chosen" ? <span className="rb-pill good">Chosen</span> : p.source === "suggested" ? <span className="rb-pill mute" title="The client's newest sending campaign — used until someone picks another">Pre-selected</span> : null}
        </div>
        <p className="rx-hint cl-hint">New Prospects go to this EmailBison campaign. Adding them automatically is not switched on yet.</p>
        {view.campaignsError ? (
          <p className="rx-hint cl-bad">This client&apos;s campaigns could not be read just now: {view.campaignsError}</p>
        ) : !view.campaigns.length ? (
          <p className="rx-hint">This client has no EmailBison campaigns yet — one is pre-selected as soon as it has one.</p>
        ) : (
          <div className="cl-pick">
            <select id="rx-prospects-campaign" aria-label="Prospects campaign" className="ds-input" value={pick} disabled={busy !== null} onChange={(e) => setPick(e.target.value)}>
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
            <button type="button" className="rx-btn solid" disabled={!dirty || busy !== null}
              onClick={() => void save({ prospectsCampaignId: pick }, "campaign", `Prospects will go to ${nameOf(pick)}.`)}>
              {busy === "campaign" ? "Saving…" : "Save"}
            </button>
            {p.source === "chosen" && p.suggested && p.suggested.id !== chosenId ? (
              <button type="button" className="rx-btn" disabled={busy !== null}
                onClick={() => void save({ prospectsCampaignId: null }, "campaign", `Back to the pre-selected campaign, ${p.suggested!.name}.`)}>
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

      <div className="cl-card" data-testid="cl-cleanup">
        <div className="cl-head">
          <b>My Agents and DNC off this client&apos;s campaigns</b>
          <span className={`rb-pill ${state.tone}`}>{state.label}</span>
        </div>
        <p className="rx-hint cl-hint">{state.text} Only this client&apos;s own campaigns; never a blocklist; entries without an email, and company entries, are skipped.</p>
        <div className="cl-switch">
          <span className="cl-switch-label">This client&apos;s switch: <b>{on ? "on" : "off"}</b></span>
          <button type="button" className={on ? "rx-btn" : armed ? "rx-btn cl-armed" : "rx-btn solid"} disabled={busy !== null} aria-pressed={on} onClick={toggle}>
            {busy === "switch" ? "Saving…" : on ? "Switch off" : armed ? "Click again — its live campaigns can change" : "Switch on"}
          </button>
        </div>
        {view.recent.length ? (
          <ul className="cl-recent" aria-label="Recent entries">
            {view.recent.slice(0, 5).map((r) => (
              <li key={r.id}>
                <span className={`rb-pill ${ENTRY_TONE[r.status]}`}>{ENTRY_WORD[r.status]}</span>
                <div>
                  <b title={r.email ?? undefined}>{r.personName ?? r.email ?? "—"}</b>
                  <small>{SOURCE_LABEL[r.source]} · {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
                  <span className="cl-line">{removalLine(r)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rx-hint cl-meta">No entries yet. The newest five show here; every entry is under Inbox → Settings → Campaign clean-up.</p>
        )}
      </div>

      {note ? <p className="rx-hint" role="status" style={note.bad ? { color: "var(--x-bad, #b42318)" } : undefined}>{note.text}</p> : null}
    </section>
  );
}
