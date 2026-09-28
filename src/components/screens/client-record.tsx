"use client";

import { useEffect, useState } from "react";

import type { ClientRow } from "@/lib/clients/overview";
import { CLIENT_STATUSES, STATUS_MEANING, isClientStatus, statusLabel, type ClientStatus } from "@/lib/clients/client-status";
import { dateStamp } from "@/lib/workspace/dates";

import { Badge, Drawer, Field, Section, type Tone } from "@/components/ds";
import { MarketsPanel } from "./markets-panel";
import { ClientPeople } from "./clients-people";
import { EditClient, TIME_ZONES } from "./clients-edit";
import { DeleteClient } from "./clients-delete";

/*
 * ONE CLIENT, EVERY FIELD, EDITABLE WHERE IT STANDS.
 *
 * Replaces the read-only popup (client-detail.tsx). The client asked for two
 * things on 29 Sep: edit the fields from this screen, and stop it looking like
 * a draft. So it is a right-hand panel rather than a centred box — the table
 * stays visible, which is what you want when working down a list — and every
 * field the master record or its owning tool accepts is edited in place.
 *
 * Each field saves ALONE through the same route as the Edit dialog
 * (/api/workspace/clients/edit), so every rule that route enforces — Stripe
 * verification, the team list, time zone checks, "a contact needs a name and a
 * role" — applies here unchanged, and its own words are shown when it refuses.
 * Plan, targets, billing and time zone are written to Client Health, which owns
 * them; the rest to the master record. The small grey line under each label
 * says which.
 *
 * Status is the exception: it moves the portal, campaigns and billing, so it
 * asks before it saves.
 */

const PLAN_OPTIONS = [
  { value: "minimum", label: "Minimum" },
  { value: "production", label: "Production" },
  { value: "partner", label: "Partner" },
];
const INTERVAL_LABEL: Record<string, string> = {
  biweekly: "Every 14 days",
  "28-days": "Every 28 days",
  monthly: "Monthly",
  custom: "Custom interval",
};
const INTERVAL_OPTIONS = ["biweekly", "28-days", "monthly"].map((v) => ({ value: v, label: INTERVAL_LABEL[v] }));

export const STATUS_BADGE: Record<ClientStatus, Tone> = {
  onboarding: "brand",
  active: "green",
  paused: "amber",
  churned: "red",
};

/** "production" → "Production"; unknown values keep their own spelling, capitalised. */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  return PLAN_OPTIONS.find((p) => p.value === plan)?.label ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function intervalLabel(v: string | null | undefined): string | null {
  return v ? INTERVAL_LABEL[v] ?? v : null;
}

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

export function ClientRecord({
  row,
  open,
  editable: canEdit = true,
  onClose,
  onChanged,
  onDeleted,
}: {
  row: ClientRow;
  open: boolean;
  /** False while the page is serving the code roster (nothing can be saved). */
  editable?: boolean;
  onClose: () => void;
  /** Called after any successful save, so the table re-reads. */
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { client, os, health, inbox, analytics, portalUrl } = row;
  const id = os.id;
  const editable = Boolean(id) && canEdit;
  const [team, setTeam] = useState<{ salespeople: string[]; accountManagers: string[] }>({ salespeople: [], accountManagers: [] });

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/workspace/clients/team", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (live && t) setTeam({ salespeople: t.salespeople ?? [], accountManagers: t.accountManagers ?? [] }); })
      .catch(() => {});
    return () => { live = false; };
  }, [open]);

  /** One field → one save → the table refreshes. */
  const save = (field: string, transform: (v: string) => unknown = (v) => v || null) =>
    editable
      ? async (v: string) => {
          await saveEdit(id!, { [field]: transform(v) });
          onChanged();
        }
      : undefined;

  const contacts = [
    { n: "contactName", r: "contactRole", e: "contactEmail", v: { name: os.contact.name, role: os.contact.role, email: os.contact.email } },
    ...os.contact.extra.map((x, i) => ({
      n: `contact${i + 2}Name`, r: `contact${i + 2}Role`, e: `contact${i + 2}Email`, v: x,
    })),
  ];
  while (contacts.length < 3) {
    const i = contacts.length + 1;
    contacts.push({ n: `contact${i}Name`, r: `contact${i}Role`, e: `contact${i}Email`, v: { name: null, role: null, email: null } });
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={`${client.name} — client record`}
      title={client.name}
      actions={
        editable && id ? (
          <>
            {/* Aliases, and every field at once — the full Edit dialog. */}
            <EditClient
              client={{
                id, name: client.name, aliases: client.aliases ?? [], status: os.status, plan: health.plan,
                weeklyTarget: health.weeklyTarget, monthlyTarget: health.monthlyTarget, timezone: health.timezone,
                contact: os.contact, record: os.record,
              }}
              onSaved={onChanged}
            />
            <DeleteClient id={id} name={client.name} onDeleted={onDeleted} />
          </>
        ) : null
      }
      subtitle={
        (client.aliases ?? []).length ? `Also known as ${(client.aliases ?? []).join(", ")}` : "Client record"
      }
      badges={
        <>
          <Badge tone={STATUS_BADGE[os.status]} dot title={STATUS_MEANING[os.status]}>{statusLabel(os.status)}</Badge>
          {planLabel(health.plan) ? <Badge tone="violet">{planLabel(health.plan)}</Badge> : null}
          {os.statusSince?.at ? <span style={{ fontSize: 12, color: "var(--ds-muted)" }}>since {dateStamp(os.statusSince.at)}</span> : null}
          {portalUrl ? (
            <a className="ds-btn sm" href={portalUrl} target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>
              Open portal ↗
            </a>
          ) : null}
        </>
      }
    >
      {!editable ? (
        <p className="ds-note" style={{ marginTop: 16 }}>
          This client has no master record yet, so its fields cannot be edited here.
        </p>
      ) : null}

      <Section title="Activity" hint="read from each tool">
        <dl className="ds-kv">
          <div><dt>Introductions</dt><dd>{inbox.intros ?? "—"}</dd></div>
          <div><dt>Last introduction</dt><dd style={{ fontSize: 14 }}>{inbox.lastIntro ? dateStamp(inbox.lastIntro) : "—"}</dd></div>
          <div><dt>Campaigns</dt><dd>{analytics.campaigns ?? "—"}</dd></div>
          <div><dt>Emails sent</dt><dd>{analytics.sent?.toLocaleString("en-US") ?? "—"}</dd></div>
        </dl>
      </Section>

      <Section title="Status" hint="changes every tool, the portal, campaigns and billing">
        <StatusField id={id} status={os.status} onChanged={onChanged} />
      </Section>

      <Section title="Plan & targets" hint="Client Health">
        <Field label="Plan" value={health.plan} display={planLabel(health.plan)}
          editor={{ kind: "select", options: PLAN_OPTIONS }} onSave={save("plan", (v) => v)} />
        <Field label="Monthly target" hint="intros per 28 days" value={health.monthlyTarget}
          editor={{ kind: "number", min: 0 }} onSave={save("monthlyTarget", (v) => Number(v || 0))} />
        <Field label="Start date" value={health.startDate} display={health.startDate ? dateStamp(health.startDate) : null}
          editor={{ kind: "date" }} onSave={save("startDate")} />
        <Field label="Time zone" value={health.timezone}
          editor={{ kind: "text", list: TIME_ZONES, placeholder: "e.g. America/New_York" }} onSave={save("timezone")} />
      </Section>

      <Section title="Billing" hint="Client Health · Stripe">
        <Field label="Interval" value={health.billingInterval} display={intervalLabel(health.billingInterval)}
          editor={{ kind: "select", options: INTERVAL_OPTIONS }} onSave={save("billingInterval", (v) => v)} />
        <Field label="Anchor date" value={health.billingAnchorDate}
          display={health.billingAnchorDate ? dateStamp(health.billingAnchorDate) : null}
          editor={{ kind: "date" }} onSave={save("billingAnchorDate")} />
        <Field label="Next billing" hint="worked out from the anchor" value={health.nextBillingDate}
          display={health.nextBillingDate ? dateStamp(health.nextBillingDate) : null} />
        <Field label="Stripe subscription" hint="checked with Stripe" value={os.record.stripeSubscriptionId}
          editor={{ kind: "text", placeholder: "sub_…" }} onSave={save("stripeSubscriptionId")} />
        <Field label="Stripe customer" hint="filled in from the subscription" value={os.record.stripeCustomerId} />
      </Section>

      <Section title="Team" hint="master record · also the Onboarding page">
        <Field label="Account manager" value={os.record.accountManager}
          editor={{ kind: "text", list: [...new Set([...team.accountManagers, ...team.salespeople])] }}
          onSave={save("accountManager")} />
        <Field label="Salesperson" value={os.record.salesperson}
          editor={{ kind: "text", list: team.salespeople }} onSave={save("salesperson")} />
        <Field label="Sender" value={os.record.sender} editor={{ kind: "text" }} onSave={save("sender")} />
        <Field label="Brokerage" value={os.contact.brokerage} editor={{ kind: "text" }} onSave={save("brokerage")} />
      </Section>

      <Section title="Markets, MLS & areas" hint="a client may cover several">
        {id ? <MarketsPanel clientId={id} /> : <p className="ds-note">No master record yet.</p>}
      </Section>

      <Section title="Introduce to" hint="used by the composer's Introduce button">
        {contacts.map((c, i) => (
          <ContactEditor key={c.n} ordinal={i} fields={c} editable={editable}
            onSave={async (patch) => { await saveEdit(id!, patch); onChanged(); }} />
        ))}
      </Section>

      <Section title="Team, agents & DNC" hint="shared with the client's portal">
        {id ? <ClientPeople clientId={id} /> : null}
      </Section>

      <Section title="Where this client exists">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge tone={health.present ? "green" : "red"} dot>Client Health</Badge>
          <Badge tone={inbox.present ? "green" : "red"} dot>Master Inbox</Badge>
          <Badge tone={analytics.present ? "green" : "red"} dot>Analytics</Badge>
          <Badge tone={os.inOnboarding ? "green" : "outline"} dot>Database / Onboarding</Badge>
          <Badge tone={portalUrl ? "green" : "outline"} dot>Portal</Badge>
        </div>
        <Field label="Client ID" hint="master record" value={id} display={<code style={{ fontSize: 12 }}>{id}</code>} />
      </Section>
    </Drawer>
  );
}

/*
 * Status, with a confirmation. A status change is not a label: pausing or
 * churning closes the client's portal and pauses its campaigns and Stripe
 * billing; reactivating resumes billing and reopens the portal (campaigns stay
 * paused — restarting them is a person's decision). The table's inline select
 * does the same thing; here, where people come to edit many fields at once, a
 * slip of the mouse should not do it.
 */
function StatusField({ id, status, onChanged }: { id: string | null; status: ClientStatus; onChanged: () => void }) {
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
    if (!id || !pending) return;
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
      <div className="ds-seg" role="group" aria-label="Client status">
        {CLIENT_STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={(pending ?? status) === s} disabled={!id || saving}
            title={STATUS_MEANING[s]} onClick={() => { setError(null); setPending(s === status ? null : s); }}>
            {statusLabel(s)}
          </button>
        ))}
      </div>
      {pending && isClientStatus(pending) ? (
        <div className="ds-note" role="alert" style={{ display: "grid", gap: 8 }}>
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
 * "<name>, <role>"), so editing them one at a time could never add someone.
 * Clearing the name and role removes the person.
 */
function ContactEditor({
  ordinal,
  fields,
  editable,
  onSave,
}: {
  ordinal: number;
  fields: { n: string; r: string; e: string; v: { name: string | null; role: string | null; email: string | null } };
  editable: boolean;
  onSave: (patch: Record<string, string | null>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", role: "", email: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = ordinal === 0 ? "First contact" : ordinal === 1 ? "Second contact" : "Third contact";
  const { name, role, email } = fields.v;

  function start() {
    if (!editable) return;
    setDraft({ name: name ?? "", role: role ?? "", email: email ?? "" });
    setError(null);
    setEditing(true);
  }
  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        [fields.n]: draft.name.trim() || null,
        [fields.r]: draft.role.trim() || null,
        [fields.e]: draft.email.trim() || null,
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-field" style={{ alignItems: editing ? "start" : "center" }}>
      <div className="ds-field-l"><span>{label}</span></div>
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
          <button type="button" className={`ds-value${editable ? "" : " readonly"}`} onClick={start}
            aria-label={editable ? `Edit ${label}` : undefined}>
            <span style={{ minWidth: 0 }}>
              {name ? (
                <>
                  {name}{role ? <span style={{ color: "var(--ds-muted)" }}>, {role}</span> : null}
                  {email ? <span style={{ display: "block", fontSize: 12, color: "var(--ds-muted)" }}>{email}</span> : null}
                </>
              ) : <span className="empty">{ordinal === 0 ? "Not set" : "Add a person"}</span>}
            </span>
            {editable ? <span className="pen" aria-hidden="true">Edit</span> : null}
          </button>
        )}
      </div>
    </div>
  );
}
