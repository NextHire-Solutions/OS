"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { fullStamp } from "@/lib/workspace/dates";

import { SequenceEditor, type EditableStep } from "./sequence-editor";
import { Btn, Toast, useToast } from "./toast";

/*
 * NEW-CLIENT TEMPLATE (Campaign Management) — the client's request: "a section in the OS where I can view and edit the
 * default campaign template used to automatically create new campaigns", with the Area variable in it "so it
 * automatically populates with the corresponding area when a campaign is created".
 *
 * The template is the EmailBison campaign every new client's first campaign is copied from (setup-campaign.ts; chosen
 * here, or with "Use for new clients…" on a campaign's Sequence tab). Its emails are shown as EmailBison holds them now
 * (setup-template ?sequence=1, read live) and edited with the OS's own sequence editor — whose Insert field menu has
 * {CLIENT_AREA}. The template has no client, so the field is saved as written and filled in for each new client when
 * its campaign is made: the client's area, or for a client with several MLSs the area set for that MLS (Record tab ›
 * Area for each MLS). A template assigned to a client is not edited here: a save would fill that client's area in for good.
 */

type Step = { id: number; order: number; email_subject: string; email_body: string; wait_in_days: number; variant: boolean; variant_from_step_id: number | null; thread_reply: boolean; active: boolean };
interface Payload {
  template: { campaignId: string; campaignName: string | null; updatedBy: string | null; updatedAt: string | null } | null;
  sequence?: { ok: true; sequenceId: number | null; steps: Step[] } | { ok: false; error: string };
  client?: { name: string | null; unread?: boolean };
}

const AREA = /\{\s*CLIENT[ _]AREA\s*\}/i;
/** An email's HTML as plain text, for reading (the editor shows and saves the real thing). */
const plain = (html: string) =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();

export function NewClientTemplateScreen() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, show } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/analytics/setup-template?sequence=1", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the template");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function changeTemplate() {
    const id = Number(newId.trim());
    if (!Number.isInteger(id) || id <= 0) { show({ text: "Enter the campaign's EmailBison id (a number).", bad: true }); return; }
    if (!window.confirm(`Use campaign ${id} for new clients?\n\nEvery new client's first campaign will be a draft copy of it — its emails, schedule and sending inboxes. Campaigns already made are not changed.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tools/analytics/setup-template", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaignId: id, confirm: true }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      show({ text: `New clients' first campaigns will be copied from ${body.template?.campaignName ?? id}.` });
      setChanging(false);
      setNewId("");
      await load();
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Could not change the template", bad: true });
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div className="ds-head" style={{ marginBottom: 16 }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <span className="ds-kicker">Campaign Management</span>
        <h1 className="ds-title">New-client template</h1>
        <div className="tbl-sub">The campaign every new client&rsquo;s first campaign is copied from — its emails, schedule and sending inboxes. Changes here apply to campaigns made from now on.</div>
      </div>
    </div>
  );

  if (error) return <div className="wrap an-screen">{head}<div className="anno" role="alert">Couldn&rsquo;t read the template — {error}</div></div>;
  if (!data) return <div className="wrap an-screen">{head}<div className="mut">Loading…</div></div>;

  const t = data.template;
  const seq = data.sequence;
  const steps = seq && seq.ok ? seq.steps : [];
  const activeSteps = steps.filter((s) => s.active);
  const hasArea = activeSteps.some((s) => AREA.test(s.email_subject) || AREA.test(s.email_body));
  const assigned = data.client?.name ?? null;

  const chooser = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {changing ? (
        <>
          <input className="inp" style={{ minWidth: 0, width: 200 }} inputMode="numeric" placeholder="EmailBison campaign id" aria-label="Template campaign id"
            value={newId} disabled={busy} onChange={(e) => setNewId(e.target.value.replace(/[^\d]/g, ""))} />
          <Btn primary disabled={busy || !newId} onClick={() => void changeTemplate()}>{busy ? "Saving…" : "Use this campaign"}</Btn>
          <Btn disabled={busy} onClick={() => { setChanging(false); setNewId(""); }}>Cancel</Btn>
        </>
      ) : (
        <Btn onClick={() => setChanging(true)}>{t ? "Change template…" : "Choose a template…"}</Btn>
      )}
    </div>
  );

  if (!t) {
    return (
      <div className="wrap an-screen">
        {head}
        <div className="anno" style={{ marginBottom: 14 }}>No template is set: a new client&rsquo;s first campaign is made as a blank draft. Choose the campaign to copy from.</div>
        {chooser}
        <Toast toast={toast} />
      </div>
    );
  }

  if (editing && seq && seq.ok) {
    const initial: EditableStep[] = steps.map((s) => ({
      key: `s${s.id}`, id: s.id, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: s.wait_in_days,
      thread_reply: s.thread_reply, variant: s.variant, variant_from_step_id: s.variant_from_step_id,
    }));
    return (
      <div className="wrap an-screen">
        {head}
        <div className="anno" role="note" style={{ marginBottom: 14 }}>
          You&rsquo;re editing the live template in EmailBison. Use <b>Insert field</b> › <code>{"{CLIENT_AREA}"}</code> — it stays as written here and is filled in with each new client&rsquo;s area when their campaign is made.
        </div>
        <SequenceEditor
          campaignId={t.campaignId}
          platform="emailbison"
          sequenceId={seq.sequenceId}
          initial={initial}
          sentStepIds={[]}
          onDone={() => setEditing(false)}
          onSaved={() => void load()}
          show={show}
        />
        <Toast toast={toast} />
      </div>
    );
  }

  return (
    <div className="wrap an-screen">
      {head}
      <div className="card" style={{ padding: "14px 16px", marginBottom: 14, display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }} data-template-card>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            <Link href={`/analytics/campaigns/${encodeURIComponent(t.campaignId)}`}>{t.campaignName ?? `Campaign ${t.campaignId}`}</Link>
            <span className="mut" style={{ fontWeight: 400 }}> · EmailBison #{t.campaignId}</span>
          </div>
          <div className="tbl-sub">{t.updatedBy || t.updatedAt ? `Set ${t.updatedBy ? `by ${t.updatedBy}` : ""}${t.updatedAt ? ` · ${fullStamp(t.updatedAt)}` : ""}` : null}</div>
        </div>
        {chooser}
      </div>

      {/* The Area variable: in the template or not, and what it becomes. */}
      {seq && seq.ok ? (
        hasArea ? (
          <div className="anno" role="status" data-area="yes" style={{ marginBottom: 14 }}>
            ✓ The template uses <code>{"{CLIENT_AREA}"}</code>. Each new client&rsquo;s campaign gets their area in its place — for a client with several MLSs, the area set for that MLS on the client&rsquo;s Record tab (Area for each MLS).
          </div>
        ) : (
          <div className="anno" role="status" data-area="no" style={{ marginBottom: 14 }}>
            The template doesn&rsquo;t use the Area variable yet. Edit the emails and use <b>Insert field</b> › <code>{"{CLIENT_AREA}"}</code> where the client&rsquo;s area should appear.
          </div>
        )
      ) : null}

      {assigned ? (
        <div className="anno" role="alert" style={{ marginBottom: 14 }}>
          This campaign is assigned to <b>{assigned}</b> in Campaign Management, so saving its emails would fill in {assigned}&rsquo;s details permanently. Unassign it (Campaign Management › Clients), or choose a template that belongs to no client, to edit it here.
        </div>
      ) : data.client?.unread ? (
        <div className="anno" role="alert" style={{ marginBottom: 14 }}>Couldn&rsquo;t check whether this campaign belongs to a client, so editing is off for now. Reload to try again.</div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0 10px" }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Emails {seq && seq.ok ? <span className="mut" style={{ fontWeight: 400 }}>· {steps.filter((s) => !s.variant).length} steps, as EmailBison has them now</span> : null}</h2>
        <Btn primary disabled={!seq || !seq.ok || !!assigned || !!data.client?.unread || seq.sequenceId === null} title={seq && seq.ok && seq.sequenceId === null ? "EmailBison returned no sequence for this campaign" : undefined} onClick={() => setEditing(true)}>Edit emails</Btn>
      </div>

      {seq && !seq.ok ? <div className="anno" role="alert">Couldn&rsquo;t read the template&rsquo;s emails from EmailBison — {seq.error}</div> : null}
      {seq && seq.ok && !steps.length ? <div className="mut">The template has no emails yet.</div> : null}
      {seq && seq.ok ? (
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
          {steps.map((s, i) => {
            const n = steps.slice(0, i + 1).filter((x) => !x.variant).length;
            return (
              <li key={s.id} className="card" style={{ padding: "12px 14px", opacity: s.active ? 1 : 0.55, marginLeft: s.variant ? 24 : 0 }} data-step={s.id}>
                <div className="tbl-sub" style={{ marginBottom: 4 }}>
                  {s.variant ? `Email ${n} · another version` : `Email ${n}`}{!s.variant && i > 0 ? ` · ${s.wait_in_days} day${s.wait_in_days === 1 ? "" : "s"} after the previous` : ""}{s.thread_reply ? " · sent as a reply" : ""}{s.active ? "" : " · turned off"}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{s.thread_reply ? <span className="mut">Re: </span> : null}{s.email_subject || <i className="mut">No subject</i>}</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{plain(s.email_body) || <i className="mut">Empty</i>}</div>
              </li>
            );
          })}
        </ol>
      ) : null}
      <Toast toast={toast} />
    </div>
  );
}
