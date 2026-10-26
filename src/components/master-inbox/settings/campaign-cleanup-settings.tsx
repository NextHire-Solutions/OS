"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Switch } from "@/components/mi-ui/switch";
import type { CleanupOverview, RemovalRow } from "@/lib/clients/campaign-lists/sweep";
import { LIVE_ENV, LIVE_ONLY_ENV, removalLine, SOURCE_LABEL } from "@/lib/clients/campaign-lists/rules";
import { stamp } from "@/lib/tools/master-inbox/relay/wording";

import { Btn, ConfirmButton, Field, Section, ToastHost, ToggleRow, useShowToast } from "./ui";

/*
 * Inbox → Settings → Campaign clean-up (admins). When a portal adds someone to
 * My Agents or DNC, take them off that client's own campaigns
 * (lib/clients/campaign-lists/). The switches, a one-address check that
 * changes nothing, the clients switched on, and the log.
 *
 * Every change is a PUT/POST the server validates again; the server's own
 * lock (OS_CAMPAIGN_CLEANUP_LIVE) and test fence are shown, never changeable
 * from here.
 */

async function send(url: string, method: "PUT" | "POST", body: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ...json, ok: res.ok, error: res.ok ? undefined : json.error ?? `Failed (${res.status})` };
}

const API = "/api/tools/master-inbox/campaign-cleanup";

export function CampaignCleanupSettings({ initial }: { initial: CleanupOverview }) {
  return (
    <ToastHost>
      <Panel key={initial.settings.updatedAt ?? "new"} data={initial} />
    </ToastHost>
  );
}

function Panel({ data }: { data: CleanupOverview }) {
  const router = useRouter();
  const show = useShowToast();
  const s = data.settings;
  const [enabled, setEnabled] = useState(s.enabled);
  const [practice, setPractice] = useState(s.practiceMode);
  const [busy, setBusy] = useState(false);

  if (!s.available) {
    return (
      <Section title="Not set up yet">
        <p className="mut">
          Run migration <b>0042_campaign_lists.sql</b> in the Master Inbox database first. Until then the clean-up does nothing at all.
        </p>
      </Section>
    );
  }

  const fence = data.server.liveOnly;
  const state = !s.enabled
    ? "Off — nothing is looked up or removed."
    : s.practiceMode
      ? "Practice — each new My Agents and DNC entry is looked up and the campaigns it would come off are recorded. Nothing is removed."
      : !data.server.liveAllowed
        ? "Practice on this server — Settings allow removing, but the server's own lock is closed, so nothing is removed."
        : `Live for ${data.clientsOn.length} client${data.clientsOn.length === 1 ? "" : "s"}${data.clientsOn.length ? ` (${data.clientsOn.map((c) => c.name).join(", ")})` : ""}${fence ? `, only on campaign${fence.length === 1 ? "" : "s"} ${fence.join(", ") || "— none"}` : ""}; practice for the rest.`;
  const leavingPractice = s.practiceMode && !practice;

  const save = async () => {
    const changed: Record<string, unknown> = {};
    if (enabled !== s.enabled) changed.enabled = enabled;
    if (practice !== s.practiceMode) changed.practiceMode = practice;
    if (!Object.keys(changed).length) return show({ text: "Nothing changed" });
    setBusy(true);
    const r = await send(API, "PUT", { ...changed, ifUpdatedAt: s.updatedAt });
    setBusy(false);
    show(r.ok ? { text: "Saved" } : { text: r.error ?? "Could not save", bad: true });
    router.refresh();
  };

  const counts = Object.entries(data.counts).filter(([, n]) => n);

  return (
    <>
      <Section title="Where it stands" sub={state}>
        <div className="mis-g mis-g2">
          <div>
            <div className="mis-l">This server</div>
            <div className="mut">
              Removing: <b>{data.server.liveAllowed ? "allowed" : "locked"}</b> ({LIVE_ENV})
              {fence ? (
                <>
                  {" "}· Only campaign{fence.length === 1 ? "" : "s"}: <b>{fence.length ? fence.join(", ") : "none"}</b> ({LIVE_ONLY_ENV} — every other campaign is practised)
                </>
              ) : null}
            </div>
          </div>
          <div>
            <div className="mis-l">Last 7 days</div>
            <div className="mut">{counts.length ? counts.map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(" · ") : "Nothing yet."}</div>
          </div>
        </div>
        <p className="mut" style={{ marginTop: 12 }}>
          The blocklists are not touched: a portal's My Agents and DNC adds already block the address everywhere, as before. This takes the person off that one
          client's own EmailBison campaigns as well, so the campaigns — and the new portal's Prospects — stop listing them. Entries with a name and no email, and
          company entries, are skipped.
        </p>
      </Section>

      <Section title="Switches" sub={s.updatedBy ? `Last changed by ${s.updatedBy}${s.updatedAt ? ` · ${stamp(s.updatedAt, "1970-01-01")}` : ""}` : undefined}>
        <ToggleRow title="Clean-up on" hint="Off stops everything at once, even mid-way. Turning it on starts from now — nothing added to My Agents or DNC earlier is ever looked at — and always in practice.">
          <Switch checked={enabled} aria-label="Clean-up on" onCheckedChange={setEnabled} />
        </ToggleRow>
        <ToggleRow title="Practice mode" hint="Look each person up and record which campaigns they would come off — remove nothing. Leaving practice also starts from now.">
          <Switch checked={practice} aria-label="Practice mode" onCheckedChange={setPractice} />
        </ToggleRow>
        <p className="mut" style={{ marginTop: 8 }}>
          Removing for real also needs each client's own switch (client record → Campaigns) and the server's lock open.
        </p>
        <div className="mis-act">
          {leavingPractice ? (
            <ConfirmButton
              label="Save — leave practice"
              armedLabel="Click again: clients switched on lose these people from their live campaigns"
              title="Clients switched on will have My Agents and DNC people taken off their live campaigns once the server's lock is open."
              onConfirm={save}
              disabled={busy}
            />
          ) : (
            <Btn primary onClick={save} disabled={busy}>
              Save
            </Btn>
          )}
        </div>
      </Section>

      <Check clients={data.clients} />
      <Recent rows={data.recent} canRemove={data.server.liveAllowed && s.enabled && !s.practiceMode} />
    </>
  );
}

/** One address, one client: what would happen now. Reads EmailBison once; changes and records nothing. */
function Check({ clients }: { clients: CleanupOverview["clients"] }) {
  const [clientId, setClientId] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ client: { name: string }; email: string; campaignsChecked: number; rows: { campaignId: string; campaignName: string; leadStatus: string | null; wouldBe: string; reason: string | null }[] } | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    const r = await send(`${API}/check`, "POST", { clientId, email });
    setBusy(false);
    if (r.ok) setRes(r as never);
    else setErr(r.error ?? "Could not check");
  };
  return (
    <Section title="Check one email" sub="Which of a client's campaigns this address is on, and what the clean-up would do with each right now. Changes nothing.">
      <div className="mis-g mis-g2">
        <Field label="Client" htmlFor="cc-client">
          <select id="cc-client" className="sel" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Email" htmlFor="cc-email">
          <input id="cc-email" className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@brokerage.com" />
        </Field>
      </div>
      <div className="mis-act">
        <Btn onClick={run} disabled={busy || !clientId || !email.trim()}>
          {busy ? "Checking…" : "Check"}
        </Btn>
      </div>
      {err ? <p className="mis-err">{err}</p> : null}
      {res ? (
        <div style={{ marginTop: 12 }} data-testid="cc-check-result">
          {res.rows.length === 0 ? (
            <p className="mut">
              {res.email} is not on any of {res.client.name}&apos;s {res.campaignsChecked} EmailBison campaign{res.campaignsChecked === 1 ? "" : "s"}.
            </p>
          ) : (
            <div className="tbl-scroll">
              <table className="atbl">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Their status there</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r) => (
                    <tr key={r.campaignId}>
                      <td>{r.campaignName}</td>
                      <td>{r.leadStatus?.replace(/_/g, " ") ?? "—"}</td>
                      <td>{r.wouldBe === "removed" ? "Would be removed" : r.wouldBe === "practice" ? `Practice — ${r.reason}` : r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </Section>
  );
}

export function Recent({ rows, canRemove, title = "Recent entries" }: { rows: RemovalRow[]; canRemove: boolean; title?: string }) {
  const router = useRouter();
  const show = useShowToast();
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (id: string) => {
    setBusy(id);
    const r = await send(`${API}/remove`, "POST", { id, confirm: true });
    setBusy(null);
    show(r.ok ? { text: "Done — see the entry for what came off" } : { text: r.error ?? "Could not remove", bad: true });
    router.refresh();
  };
  return (
    <Section title={title} sub="Every My Agents and DNC entry the clean-up looked at, newest first.">
      {rows.length === 0 ? (
        <p className="mut">None yet.</p>
      ) : (
        <div className="tbl-scroll">
          <table className="atbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Person</th>
                <th>Client</th>
                <th>What happened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="tnum" style={{ whiteSpace: "nowrap" }}>
                    {stamp(r.createdAt, "1970-01-01")}
                  </td>
                  <td>
                    {r.personName ?? r.email ?? "—"}
                    <div className="mut">
                      {SOURCE_LABEL[r.source]}
                      {r.email && r.personName ? ` · ${r.email}` : ""}
                    </div>
                  </td>
                  <td>{r.clientName ?? "—"}</td>
                  <td>
                    {removalLine(r)}
                    {r.decidedBy && r.decidedBy !== "sweep" ? <div className="mut">by {r.decidedBy}</div> : null}
                  </td>
                  <td>
                    {canRemove && (r.status === "practice" || r.status === "partly_removed" || r.status === "failed") ? (
                      <ConfirmButton
                        label="Remove now"
                        armedLabel="Click again: off these live campaigns"
                        title="Looks the person up again and takes them off this client's campaigns for real — only while the clean-up is live and this client's own switch is on."
                        onConfirm={() => remove(r.id)}
                        disabled={busy === r.id}
                        compact
                      >
                        ✕
                      </ConfirmButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
