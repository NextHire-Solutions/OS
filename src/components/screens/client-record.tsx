"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Field, StatusPill, type FieldEditor } from "@/components/ds";
import {
  Cell, Id, PlanTag, avatarStyle, fmtDay, fmtNum, initials, intervalLabel, planLabel, tzLabel,
} from "@/components/clients/cells";
import { CATEGORIES, CATEGORY_LABEL, fieldsIn, type FieldDef } from "@/lib/clients/field-registry";
import type { MasterClient } from "@/lib/clients/master-list";
import { CLIENT_STATUSES, STATUS_MEANING, statusLabel, type ClientStatus } from "@/lib/clients/client-status";
import { TIME_ZONES } from "@/lib/tools/client-health/types";

import { ClientPeople } from "./clients-people";
import { DeleteClient } from "./clients-delete";
import { MarketsPanel } from "./markets-panel";

/*
 * ONE CLIENT — THE WHOLE MASTER RECORD, EDITABLE WHERE IT STANDS.
 *
 * Every field of §6 and §12, in the document's categories and words, each with
 * the system that holds it (§7 "where does this information originate?") and,
 * where the master record owns it, an in-place editor (§7 "where can it be
 * edited?"). Change it here once; the save route writes it to every tool that
 * uses it (§21 step 6–7).
 *
 * Each field saves ALONE through /api/workspace/clients/edit, so every rule the
 * route enforces — Stripe verification, time zone checks, "a contact needs a
 * name and a role" — applies unchanged and its own words are shown when it
 * refuses. Status asks before it saves: it moves the portal, campaigns and
 * billing (§10).
 */

type Tab = "record" | "campaigns" | "people" | "markets" | "introduce" | "tools";

const TABS: { id: Tab; label: string }[] = [
  { id: "record", label: "Master record" },
  { id: "campaigns", label: "Campaigns" },
  { id: "people", label: "Team, agents & DNC" },
  { id: "markets", label: "Markets" },
  { id: "introduce", label: "Introduce to" },
  { id: "tools", label: "Tools" },
];

const PLAN_OPTIONS = [
  { value: "minimum", label: "Minimum" }, { value: "production", label: "Production" }, { value: "partner", label: "Partner" },
];
const INTERVAL_OPTIONS = ["biweekly", "28-days", "monthly"].map((v) => ({ value: v, label: intervalLabel(v) ?? v }));
const TZ_OPTIONS = TIME_ZONES.map((t) => ({ value: t.value, label: t.label }));

async function saveEdit(id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/workspace/clients/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Could not save (HTTP ${res.status})`);
  // A 200 can carry a leg that failed — say so rather than report success.
  if (body?.failed?.length) throw new Error(`${body.failed[0].what}: ${body.failed[0].error}`);
}

/** Which fields edit in place, how, and which route key they save to. */
function editorFor(f: FieldDef, team: { salespeople: string[]; accountManagers: string[] }):
  { editor: FieldEditor; save: string; transform?: (v: string) => unknown } | null {
  switch (f.key) {
    case "name": return { editor: { kind: "text", maxLength: 80 }, save: "name", transform: (v) => v };
    case "plan": return { editor: { kind: "select", options: PLAN_OPTIONS }, save: "plan", transform: (v) => v };
    case "startDate": return { editor: { kind: "date" }, save: "startDate" };
    case "timezone": return { editor: { kind: "select", options: TZ_OPTIONS }, save: "timezone" };
    case "sender": case "campaignSender": return { editor: { kind: "text" }, save: "sender" };
    case "salesperson": return { editor: { kind: "text", list: team.salespeople }, save: "salesperson" };
    case "accountManager": return { editor: { kind: "text", list: [...new Set([...team.accountManagers, ...team.salespeople])] }, save: "accountManager" };
    case "billingAnchorDate": return { editor: { kind: "date" }, save: "billingAnchorDate" };
    case "billingInterval": return { editor: { kind: "select", options: INTERVAL_OPTIONS }, save: "billingInterval", transform: (v) => v };
    case "stripeSubscriptionId": return { editor: { kind: "text", placeholder: "sub_…" }, save: "stripeSubscriptionId" };
    case "stripeCustomerId": return { editor: { kind: "text", placeholder: "cus_…" }, save: "stripeCustomerId" };
    case "campaignAliases": return {
      editor: { kind: "text", placeholder: "Comma-separated, e.g. Keyes, The Keyes Co" }, save: "aliases",
      transform: (v) => v.split(",").map((s) => s.trim()).filter(Boolean),
    };
    case "monthlyTarget": return { editor: { kind: "number", min: 0 }, save: "monthlyTarget", transform: (v) => Number(v || 0) };
    default: return null;
  }
}

/** The raw value an editor starts from. */
function rawOf(f: FieldDef, c: MasterClient): string | number | null {
  switch (f.key) {
    case "campaignAliases": return c.campaignAliases.join(", ");
    case "campaignSender": return c.sender;
    default: {
      const v = (c as unknown as Record<string, unknown>)[f.key];
      return typeof v === "string" || typeof v === "number" ? v : null;
    }
  }
}

/** Where to manage a field that is edited elsewhere (tab in this panel, or another tool). */
const MANAGED_IN: Record<string, Tab> = {
  market: "markets", mls: "markets", area: "markets",
  team: "people", agents: "people", dnc: "people",
  campaignId: "campaigns", campaignName: "campaigns", campaignStatus: "campaigns",
};

export function ClientRecord({
  client: c, onClose, onChanged, onDeleted,
}: {
  client: MasterClient;
  onClose: () => void;
  /** Called after any successful save, so the list re-reads. */
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<Tab>("record");
  const [team, setTeam] = useState<{ salespeople: string[]; accountManagers: string[] }>({ salespeople: [], accountManagers: [] });

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/clients/team", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (live && t) setTeam({ salespeople: t.salespeople ?? [], accountManagers: t.accountManagers ?? [] }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const save = (key: string, transform: (v: string) => unknown = (v) => v || null) => async (v: string) => {
    await saveEdit(c.id, { [key]: transform(v) });
    onChanged();
  };

  const period = c.health.period;
  const daysToBilling = c.nextBillingDate
    ? Math.round((Date.parse(`${c.nextBillingDate}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000)
    : null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="ds-scrim" onClick={onClose} />
      <aside className="rx" role="dialog" aria-modal="true" aria-label={`${c.name} — client record`}>
        {/* ------------------------------------------------------- header */}
        <header className="rx-head">
          <div className="rx-id">
            <span className="cx-av lg" style={avatarStyle(c.name)} aria-hidden="true">{initials(c.name)}</span>
            <div style={{ minWidth: 0 }}>
              <h2>{c.name}</h2>
              <div className="rx-tags">
                <StatusPill status={c.status} />
                <PlanTag plan={c.plan} />
                {c.statusSince ? <span className="rx-meta">{statusLabel(c.status)} since {fmtDay(c.statusSince)}</span> : null}
              </div>
              <div className="rx-meta-row">
                <span>Client ID <Id value={c.id} /></span>
                {c.dateAdded ? <span>Added {fmtDay(c.dateAdded)}</span> : null}
                {c.aliases.length ? <span title={c.aliases.join(", ")}>aka {c.aliases.join(", ")}</span> : null}
              </div>
            </div>
          </div>
          <div className="rx-actions">
            {c.portal.url ? <a className="ds-btn sm" href={c.portal.url} target="_blank" rel="noreferrer">Open portal ↗</a> : null}
            <DeleteClient id={c.id} name={c.name} onDeleted={onDeleted} />
            <button type="button" className="ds-btn ghost icon sm" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </header>

        {/* ------------------------------------------------------ KPI strip */}
        <div className="rx-kpis">
          <div>
            <small>Introductions delivered</small>
            <b>{fmtNum(c.introductions) ?? "—"}</b>
            <span>{c.lastIntroAt ? `last ${fmtDay(c.lastIntroAt)}` : "none yet"}</span>
          </div>
          <div>
            <small>This 28-day period</small>
            <b>{period ? `${period.delivered}/${period.target}` : "—"}</b>
            <span>{c.health.pace === "done" ? "target met" : c.health.pace === "ok" ? "on pace" : c.health.pace === "risk" ? "behind pace" : "no target set"}</span>
          </div>
          <div>
            <small>Next billing</small>
            <b>{c.nextBillingDate ? fmtDay(c.nextBillingDate)?.replace(/, \d{4}$/, "") : "—"}</b>
            <span>{daysToBilling === null ? "no schedule" : daysToBilling === 0 ? "today" : `in ${daysToBilling} day${daysToBilling === 1 ? "" : "s"} · ${intervalLabel(c.billingInterval, c.billingIntervalDays)?.toLowerCase()}`}</span>
          </div>
          <div>
            <small>Agents</small>
            <b>{fmtNum(c.agents) ?? "—"}</b>
            <span>{c.team !== null ? `${c.team} team · ${fmtNum(c.dnc)} DNC` : "—"}</span>
          </div>
        </div>

        {/* ----------------------------------------------------------- tabs */}
        <nav className="rx-tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? "on" : ""} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "campaigns" && c.campaigns ? <span className="n">{c.campaigns.length}</span> : null}
              {t.id === "markets" && c.markets ? <span className="n">{c.markets.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="rx-body">
          {tab === "record" ? (
            <>
              <section className="rx-sec">
                <h3>Status <span>changes every tool, the portal, campaigns and billing</span></h3>
                <StatusField id={c.id} status={c.status} onChanged={onChanged} />
              </section>
              {CATEGORIES.map((cat) => (
                <section key={cat} className={`rx-sec cat-${cat}`}>
                  <h3><i aria-hidden="true" />{CATEGORY_LABEL[cat]}</h3>
                  {fieldsIn(cat).filter((f) => f.key !== "status").map((f) => {
                    const ed = editorFor(f, team);
                    const managed = MANAGED_IN[f.key];
                    return (
                      <div key={f.key} className="rx-field" title={f.definition}>
                        {ed ? (
                          <Field
                            label={f.label}
                            source={f.source}
                            value={rawOf(f, c)}
                            display={displayFor(f, c)}
                            editor={ed.editor}
                            onSave={save(ed.save, ed.transform)}
                          />
                        ) : (
                          <div className="ds-field">
                            <div className="ds-field-l">
                              <span>{f.label}</span>
                              <em className="ds-field-src">{f.source}</em>
                            </div>
                            <div className="ds-field-v">
                              <div className="rx-static">
                                <Cell k={f.key} c={c} />
                                {managed ? (
                                  <button type="button" className="ds-link" onClick={() => setTab(managed)}>
                                    {managed === "campaigns" ? "See campaigns" : "Manage"}
                                  </button>
                                ) : <small className="rx-why">{f.editIn}</small>}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              ))}
            </>
          ) : null}

          {tab === "campaigns" ? <Campaigns c={c} /> : null}

          {tab === "people" ? (
            <section className="rx-sec">
              <h3>Team, agents & DNC <span>held by Master Inbox · shared with the client&rsquo;s portal</span></h3>
              <ClientPeople clientId={c.id} />
            </section>
          ) : null}

          {tab === "markets" ? (
            <section className="rx-sec">
              <h3>Market, MLS & area <span>a client may cover several</span></h3>
              <MarketsPanel clientId={c.id} />
            </section>
          ) : null}

          {tab === "introduce" ? (
            <section className="rx-sec">
              <h3>Introduce to <span>used by the Introduce button in Master Inbox</span></h3>
              <Field label="Brokerage" source="Master record" value={c.contact.brokerage}
                editor={{ kind: "text" }} onSave={save("brokerage")} />
              {[0, 1, 2].map((i) => {
                const v = i === 0 ? { name: c.contact.name, role: c.contact.role, email: c.contact.email } : c.contact.extra[i - 1] ?? { name: null, role: null, email: null };
                const p = i === 0 ? "contact" : `contact${i + 1}`;
                return (
                  <ContactEditor key={i} ordinal={i} value={v}
                    onSave={async (d) => { await saveEdit(c.id, { [`${p}Name`]: d.name, [`${p}Role`]: d.role, [`${p}Email`]: d.email }); onChanged(); }} />
                );
              })}
            </section>
          ) : null}

          {tab === "tools" ? <Tools c={c} /> : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** How an editable field reads when not being edited. */
function displayFor(f: FieldDef, c: MasterClient): React.ReactNode {
  switch (f.key) {
    case "plan": return planLabel(c.plan);
    case "timezone": return tzLabel(c.timezone);
    case "startDate": case "billingAnchorDate": return fmtDay(c[f.key]);
    case "billingInterval": return intervalLabel(c.billingInterval, c.billingIntervalDays);
    case "campaignAliases": return c.campaignAliases.length ? c.campaignAliases.join(", ") : null;
    case "monthlyTarget": return c.monthlyTarget === null ? null : `${c.monthlyTarget} per 28 days`;
    default: return undefined;
  }
}

/* ---------------------------------------------------------------- campaigns --- */
function Campaigns({ c }: { c: MasterClient }) {
  if (!c.campaigns) return <p className="ds-note">Campaigns could not be read.</p>;
  if (!c.campaigns.length) return <p className="ds-note">No campaign is linked to {c.name} yet.</p>;
  const tone = (s: string | null) => (s === "running" ? "t-green" : s === "paused" ? "t-orange" : "");
  return (
    <section className="rx-sec">
      <h3>Campaign Information <span>read from Instantly and EmailBison</span></h3>
      <div className="rx-camps">
        {c.campaigns.map((x) => (
          <div key={`${x.platform}:${x.id}`} className="rx-camp">
            <span className={`rx-plat ${x.platform === "Instantly" ? "i" : "b"}`}>{x.platform === "Instantly" ? "IN" : "EB"}</span>
            <div style={{ minWidth: 0 }}>
              <b title={x.name}>{x.name}</b>
              <small>Campaign ID <Id value={x.id} /></small>
            </div>
            <span className="rx-camp-r">
              {x.leads !== null ? <small>{fmtNum(x.leads)} leads</small> : null}
              <span className={`cx-chip ${tone(x.status)}`}>{x.status ? x.status.charAt(0).toUpperCase() + x.status.slice(1) : "Unknown"}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="rx-hint">Aliases: {c.campaignAliases.length ? c.campaignAliases.join(", ") : "none"} · Sender: {c.sender ?? "not recorded"} · MLS/location: {c.campaignLocation ?? "not recorded"}</p>
    </section>
  );
}

/* -------------------------------------------------------------------- tools --- */
function Tools({ c }: { c: MasterClient }) {
  const rows: { tool: string; present: boolean | null; note: string }[] = [
    { tool: "Master Inbox", present: c.portal.count > 0, note: c.portal.count ? `${c.portal.count} portal${c.portal.count === 1 ? "" : "s"} · ${fmtNum(c.introductions) ?? 0} introductions` : "no inbox client" },
    { tool: "Client Portal", present: c.portal.url ? true : c.portal.count ? false : null, note: c.portal.url ? "open" : c.portal.count ? "closed" : "none" },
    { tool: "Client Health", present: c.health.present, note: c.health.present ? `${planLabel(c.plan) ?? "no plan"} · ${c.monthlyTarget ?? 0} / 28 days` : "not in Client Health" },
    { tool: "Database", present: c.database.present, note: c.database.present ? `${fmtNum(c.assignedLeads) ?? 0} leads · ${fmtNum(c.replies) ?? 0} replies` : "not in the Database" },
    { tool: "Onboarding", present: c.onboarding.present, note: c.onboarding.progress ? `${c.onboarding.progress.done}/${c.onboarding.progress.total} steps` : "—" },
    { tool: "Analytics", present: c.analytics.present, note: c.analytics.present ? `${fmtNum(c.analytics.campaigns) ?? 0} campaigns · ${fmtNum(c.analytics.sent) ?? 0} sent` : "not in Analytics" },
  ];
  return (
    <section className="rx-sec">
      <h3>Where this client exists <span>§16 — a missing tool is a sync problem unless it is a recorded exception</span></h3>
      <div className="rx-tools">
        {rows.map((r) => (
          <div key={r.tool} className="rx-tool">
            <span className={`rx-tool-dot ${r.present ? "ok" : r.present === false ? "bad" : "na"}`} aria-hidden="true" />
            <b>{r.tool}</b>
            <small>{r.note}</small>
          </div>
        ))}
      </div>
      <p className="rx-hint">Full sync status for every client — counts, missing records, conflicts — is on <a href="/consistency">Consistency</a>.</p>
    </section>
  );
}

/*
 * Status, with a confirmation. A status change is not a label: pausing or
 * churning closes the client's portal and pauses its campaigns and Stripe
 * billing; reactivating resumes billing and reopens the portal (campaigns stay
 * paused — restarting them is a person's decision).
 */
function StatusField({ id, status, onChanged }: { id: string; status: ClientStatus; onChanged: () => void }) {
  const [pending, setPending] = useState<ClientStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effect = (s: ClientStatus): string =>
    s === "paused" || s === "churned"
      ? "The portal closes, and the client's running campaigns and Stripe billing are paused."
      : s === "active"
        ? "The portal reopens and Stripe billing resumes. Paused campaigns stay paused — restart them deliberately."
        : "Recorded in every tool. The portal is left as it is.";

  async function confirm() {
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/clients/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: pending }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setPending(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="rx-status" role="group" aria-label="Client status">
        {CLIENT_STATUSES.map((s) => (
          <button key={s} type="button" className={`st-${s}`} aria-pressed={(pending ?? status) === s} disabled={saving}
            title={STATUS_MEANING[s]} onClick={() => { setError(null); setPending(s === status ? null : s); }}>
            <span className="st-dot" aria-hidden="true" />{statusLabel(s)}
          </button>
        ))}
      </div>
      {pending ? (
        <div className="ds-note" role="alert" style={{ display: "grid", gap: 8, margin: 0 }}>
          <span><b>Change to {statusLabel(pending)}?</b> {effect(pending)}</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button type="button" className="ds-btn primary sm" disabled={saving} onClick={() => void confirm()}>
              {saving ? "Changing…" : `Change to ${statusLabel(pending)}`}
            </button>
            <button type="button" className="ds-btn ghost sm" disabled={saving} onClick={() => setPending(null)}>Cancel</button>
          </span>
        </div>
      ) : null}
      {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
    </div>
  );
}

/*
 * One person the client's introductions go to: name, role and email saved
 * TOGETHER. The server refuses a name without a role (the sentence reads
 * "<name>, <role>"). Clearing the name and role removes the person.
 */
function ContactEditor({
  ordinal, value, onSave,
}: {
  ordinal: number;
  value: { name: string | null; role: string | null; email: string | null };
  onSave: (v: { name: string | null; role: string | null; email: string | null }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", role: "", email: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = ordinal === 0 ? "First contact" : ordinal === 1 ? "Second contact" : "Third contact";

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: draft.name.trim() || null, role: draft.role.trim() || null, email: draft.email.trim() || null });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-field" style={{ alignItems: editing ? "start" : "center" }}>
      <div className="ds-field-l"><span>{label}</span><em className="ds-field-src">Master record</em></div>
      <div className="ds-field-v">
        {editing ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input className="ds-input" placeholder="Full name" aria-label={`${label} name`} value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
              <input className="ds-input" placeholder="Role, e.g. Team Leader" aria-label={`${label} role`} value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
            </div>
            <input className="ds-input" type="email" placeholder="Email (optional)" aria-label={`${label} email`} value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="ds-btn primary sm" disabled={saving} onClick={() => void commit()}>{saving ? "Saving…" : "Save"}</button>
              <button type="button" className="ds-btn ghost sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
          </div>
        ) : (
          <button type="button" className="ds-value" aria-label={`Edit ${label}`}
            onClick={() => { setDraft({ name: value.name ?? "", role: value.role ?? "", email: value.email ?? "" }); setError(null); setEditing(true); }}>
            <span style={{ minWidth: 0 }}>
              {value.name ? (
                <>
                  {value.name}{value.role ? <span style={{ color: "var(--ds-muted)" }}>, {value.role}</span> : null}
                  {value.email ? <span style={{ display: "block", fontSize: 12, color: "var(--ds-muted)" }}>{value.email}</span> : null}
                </>
              ) : <span className="empty">{ordinal === 0 ? "Not set" : "Add a person"}</span>}
            </span>
            <span className="pen" aria-hidden="true">Edit</span>
          </button>
        )}
      </div>
    </div>
  );
}
