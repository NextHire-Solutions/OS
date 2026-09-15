"use client";

import { useCallback, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { CLIENT_STATUSES, statusLabel, type ClientStatus } from "@/lib/clients/client-status";

/*
 * Editing a client, in place on the roster.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIELDS ARE GROUPED BY WHERE THEY LAND
 *
 * These four fields go to three different databases, and which one a field
 * reaches changes what happens when it is wrong. Aliases decide how every tool
 * matches campaigns to this client — the thing that had JPAR's numbers
 * attributed to nobody for weeks. Plan and weekly target are billing. Status is
 * ours alone.
 *
 * Showing them in one flat form would suggest they are equivalent. The panel
 * says where each one goes, so nobody edits billing thinking they are editing a
 * label.
 */

const LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };
const FIELD: React.CSSProperties = { display: "grid", gap: 5 };

const PLANS = ["minimum", "production", "partner"] as const;
const BILLING = ["biweekly", "28-days", "monthly", "custom"] as const;

export interface EditableClient {
  id: string;
  name: string;
  aliases: string[];
  status: ClientStatus;
  plan: string | null;
  weeklyTarget: number | null;
  /** The introduction macro's details. Null fields simply render empty. */
  contact: {
    name: string | null;
    role: string | null;
    email: string | null;
    brokerage: string | null;
  };
}

export function EditClient({ client, onSaved }: { client: EditableClient; onSaved: () => void }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ib"
        aria-label={`Edit ${client.name}`}
        title={`Edit ${client.name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 26, height: 26, color: "var(--muted)" }}
      >
        ✎
      </button>
      <ModalDialog
        open={open}
        onClose={close}
        width={540}
        label={`Edit ${client.name}`}
      >
        <EditBody client={client} onClose={close} onSaved={onSaved} />
      </ModalDialog>
    </>
  );
}

function EditBody({
  client, onClose, onSaved,
}: { client: EditableClient; onClose: () => void; onSaved: () => void }) {
  const [aliases, setAliases] = useState(client.aliases.join("\n"));
  const [status, setStatus] = useState<ClientStatus>(client.status);
  const [plan, setPlan] = useState(client.plan ?? "production");
  const [weeklyTarget, setWeeklyTarget] = useState(String(client.weeklyTarget ?? 3));
  const [billingInterval, setBillingInterval] = useState("");
  const [contactName, setContactName] = useState(client.contact.name ?? "");
  const [contactRole, setContactRole] = useState(client.contact.role ?? "");
  const [contactEmail, setContactEmail] = useState(client.contact.email ?? "");
  const [brokerage, setBrokerage] = useState(client.contact.brokerage ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ updated: string[]; failed: { what: string; error: string }[]; untouched: string[] } | null>(null);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const nextAliases = aliases.split("\n").map((a) => a.trim()).filter(Boolean);
      const body: Record<string, unknown> = { id: client.id };
      // Only send what actually changed. A field the caller did not touch must
      // not be re-asserted — see the Client Health note in lib/clients/edit.ts.
      if (JSON.stringify(nextAliases) !== JSON.stringify(client.aliases)) body.aliases = nextAliases;
      if (status !== client.status) body.status = status;
      if (plan !== (client.plan ?? "production")) body.plan = plan;
      if (Number(weeklyTarget) !== (client.weeklyTarget ?? 3)) body.weeklyTarget = Number(weeklyTarget);
      if (billingInterval) body.billingInterval = billingInterval;
      // Only what changed — an untouched field must not be re-asserted, and a
      // cleared one has to travel as "" so the server knows to null it.
      if (contactName.trim() !== (client.contact.name ?? "")) body.contactName = contactName.trim();
      if (contactRole.trim() !== (client.contact.role ?? "")) body.contactRole = contactRole.trim();
      if (contactEmail.trim() !== (client.contact.email ?? "")) body.contactEmail = contactEmail.trim();
      if (brokerage.trim() !== (client.contact.brokerage ?? "")) body.brokerage = brokerage.trim();

      if (Object.keys(body).length === 1) { onClose(); return; }

      const res = await fetch("/api/workspace/clients/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      setResult(out);
      if (!out.failed?.length) setTimeout(onSaved, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 13.5 }}>{client.name}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
          Each field says which tool it writes to.
        </div>
      </div>

      <div style={{ padding: 15, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 14 }}>
        <label style={FIELD}>
          <span style={LABEL}>
            Aliases — one per line <span className="mut">· the OS and Analytics</span>
          </span>
          <textarea
            className="as-ta"
            rows={3}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={"Other spellings a tool already uses\nOne per line"}
          />
          <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>
            These decide how campaigns are matched to this client. Add one only after
            seeing a tool actually use it — a guessed alias merges two clients silently.
          </span>
        </label>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <label style={FIELD}>
            <span style={LABEL}>Status <span className="mut">· the OS</span></span>
            <select className="inp" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus)}>
              {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Plan <span className="mut">· Client Health</span></span>
            <select className="inp" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Weekly target <span className="mut">· Client Health</span></span>
            <input className="inp tnum" type="number" min={0} value={weeklyTarget}
              onChange={(e) => setWeeklyTarget(e.target.value)} />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Billing interval <span className="mut">· Client Health</span></span>
            <select className="inp" value={billingInterval} onChange={(e) => setBillingInterval(e.target.value)}>
              <option value="">leave unchanged</option>
              {BILLING.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        </div>

        {/*
          The introduction macro's values.

          They were only ever settable while onboarding, and then only if the
          macro box was ticked — so a role typed wrongly, or a client onboarded
          before the macro existed, could never be corrected. Saving any of
          them also re-renders this client's stored "Intro Macro" template, so
          the Templates picker and the Introduce button always agree.
        */}
        <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 13, display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650 }}>Introduction details</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, lineHeight: 1.55 }}>
              Used by the <b>Introduce</b> button in a conversation: “I&rsquo;d like to introduce you
              to <i>{contactName.trim() || "…"}</i>, <i>{contactRole.trim() || "…"}</i> at{" "}
              <i>{brokerage.trim() || client.name}</i>”.
            </div>
          </div>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <label style={FIELD}>
              <span style={LABEL}>Contact full name</span>
              <input className="inp" value={contactName} maxLength={160} placeholder="Nicole Collins"
                onChange={(e) => setContactName(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Their role</span>
              <input className="inp" value={contactRole} maxLength={120} placeholder="Team Leader"
                onChange={(e) => setContactRole(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Brokerage</span>
              <input className="inp" value={brokerage} maxLength={160} placeholder={client.name}
                onChange={(e) => setBrokerage(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Contact email</span>
              <input className="inp" type="email" value={contactEmail} maxLength={200}
                placeholder="nicole@brokerage.com"
                onChange={(e) => setContactEmail(e.target.value)} />
            </label>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>
            The contact email is copied into <b>Cc</b> when the introduction is inserted — added to
            whoever is already there, never replacing them.
          </span>
        </div>

        <p style={{ margin: 0, fontSize: 11.5, color: "var(--muted)", lineHeight: 1.6 }}>
          Master Inbox keeps its own name and aliases. Its update endpoint needs a
          signed-in browser session, and renaming there rewrites the slug that prefixes
          the live portal URL — so it is left alone deliberately.
        </p>

        {error ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}

        {result ? (
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 11, display: "grid", gap: 6, fontSize: 12.5 }}>
            {result.updated.map((u) => (
              <div key={u} style={{ color: "var(--green)" }}>✓ {u}</div>
            ))}
            {result.failed.map((f) => (
              <div key={f.what} style={{ color: "var(--red)" }}>✗ {f.what}: {f.error}</div>
            ))}
            {result.untouched.map((u) => (
              <div key={u} className="mut" style={{ lineHeight: 1.55 }}>{u}</div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--line-soft)", flex: "none" }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose}>Close</button>
        <button type="button" className="btn btn-pri" style={{ flex: 2 }} disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
