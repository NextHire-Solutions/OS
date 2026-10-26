"use client";

import { useEffect, useState } from "react";

import { removalLine, SOURCE_LABEL } from "@/lib/clients/campaign-lists/rules";
import type { RemovalRow } from "@/lib/clients/campaign-lists/sweep";

/*
 * Client record → Campaigns: the client's Prospects campaign and its own
 * switch for the My Agents / DNC clean-up (lib/clients/campaign-lists/).
 * Admins only — the route answers 401/403 for everyone else and this renders
 * nothing.
 */

type View =
  | { available: false }
  | {
      available: true;
      global: { enabled: boolean; practiceMode: boolean };
      server: { liveAllowed: boolean };
      client: { removeEnabled: boolean; prospectsCampaignId: string | null; prospectsCampaignName: string | null; updatedAt: string | null; updatedBy: string | null };
      campaigns: { id: string; name: string; status: string }[];
      recent: RemovalRow[];
    };

const url = (id: string) => `/api/tools/master-inbox/campaign-cleanup/client/${encodeURIComponent(id)}`;

export function ClientCampaignLists({ clientId }: { clientId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(url(clientId), { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    setView(body as View);
    if ((body as View).available) setPick((body as Extract<View, { available: true }>).client.prospectsCampaignId ?? "");
  };
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [clientId]);

  if (error) {
    return (
      <section className="rx-sec">
        <h3>Prospects and list clean-up</h3>
        <p className="rx-hint" style={{ color: "var(--x-bad, #b42318)" }}>{error}</p>
      </section>
    );
  }
  if (!view) return null;
  if (!view.available) {
    return (
      <section className="rx-sec">
        <h3>Prospects and list clean-up</h3>
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
    setArmed(false);
    if (!res.ok) return setNote(body?.error ?? `Could not save (${res.status})`);
    setNote(done);
    await load().catch(() => {});
  };

  const on = view.client.removeEnabled;
  const where = !view.global.enabled
    ? "The clean-up is switched off in Inbox → Settings → Campaign clean-up."
    : view.global.practiceMode
      ? "The clean-up is in practice: it records what it would remove, for every client, and removes nothing."
      : !view.server.liveAllowed
        ? "Settings allow removing, but the server's lock is closed — nothing is removed."
        : on
          ? "Live for this client."
          : "Practice for this client until its switch is on.";
  const toggle = () => {
    if (on) return void save({ removeEnabled: false }, "Switched off — this client's campaigns are no longer changed.");
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    void save({ removeEnabled: true }, "Switched on.");
  };

  return (
    <section className="rx-sec" id="rx-campaign-lists">
      <h3>Prospects and list clean-up<span>admins only</span></h3>

      <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
        <label className="rx-hint" htmlFor="rx-prospects-campaign" style={{ fontWeight: 600 }}>Prospects campaign</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select id="rx-prospects-campaign" className="ds-input" style={{ minWidth: 0, flex: "1 1 260px", maxWidth: 520 }} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
            <option value="">None chosen</option>
            {view.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.status})
              </option>
            ))}
          </select>
          <button type="button" className="rx-btn solid" disabled={busy || pick === (view.client.prospectsCampaignId ?? "")}
            onClick={() => void save({ prospectsCampaignId: pick || null }, pick ? "Prospects campaign saved." : "Prospects campaign cleared.")}>
            Save
          </button>
        </div>
        <p className="rx-hint">
          The EmailBison campaign this client&apos;s new Prospects will be added to. Saving a choice adds no one yet: adding Prospects automatically is the next step,
          and it will ask before it is switched on.
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <b>Take My Agents and DNC people off this client&apos;s campaigns</b>
          <p className="rx-hint" style={{ marginTop: 4 }}>
            New entries on this client&apos;s portal lists come off its own EmailBison campaigns — never another client&apos;s. Entries without an email, and
            company entries, are skipped. {where}
          </p>
        </div>
        <button type="button" className={on ? "rx-btn" : "rx-btn solid"} disabled={busy} aria-pressed={on} onClick={toggle}
          style={armed ? { borderColor: "var(--x-bad, #b42318)", color: "var(--x-bad, #b42318)" } : undefined}>
          {on ? "Switch off" : armed ? "Click again: changes this client's live campaigns" : "Switch on"}
        </button>
      </div>
      {view.client.updatedBy ? <p className="rx-hint">Last changed by {view.client.updatedBy}.</p> : null}
      {note ? <p className="rx-hint" role="status">{note}</p> : null}

      {view.recent.length ? (
        <div className="rx-camps" style={{ marginTop: 12 }}>
          {view.recent.map((r) => (
            <div key={r.id} className="rx-camp" style={{ gridTemplateColumns: "1fr" }}>
              <div style={{ minWidth: 0 }}>
                <b title={r.email ?? undefined}>{r.personName ?? r.email ?? "—"}</b>
                <small>
                  <span>{SOURCE_LABEL[r.source]}</span>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                </small>
                <p className="rx-hint" style={{ margin: "4px 0 0" }}>{removalLine(r)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
