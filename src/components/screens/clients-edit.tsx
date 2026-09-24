"use client";

import { useCallback, useRef, useState } from "react";
import { introPeopleSentence } from "@/lib/tools/master-inbox/inbox/intro-macro";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { ClientPeople } from "@/components/screens/clients-people";
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
  monthlyTarget: number | null;
  timezone: string | null;
  /** The introduction macro's details. Null fields simply render empty. */
  contact: {
    name: string | null;
    role: string | null;
    email: string | null;
    brokerage: string | null;
    /** The second and third people. Always two entries, either may be empty. */
    extra: Array<{ name: string | null; role: string | null; email: string | null }>;
  };
  /** The §6 master-record fields the OS owns outright (migration 0015). */
  record: {
    accountManager: string | null;
    salesperson: string | null;
    sender: string | null;
    market: string | null;
    mls: string | null;
    area: string | null;
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
  const [monthlyTarget, setMonthlyTarget] = useState(
    client.monthlyTarget === null ? "" : String(client.monthlyTarget),
  );
  const [timezone, setTimezone] = useState(client.timezone ?? "");

  const [billingInterval, setBillingInterval] = useState("");
  /*
   * The three people, as one array rather than nine useStates.
   *
   * Slot 0 is the contact this screen has always had; 1 and 2 are the second
   * and third the client asked for. Keeping them in one shape is what lets the
   * preview sentence, the save diff and the rendered fields all walk the same
   * list instead of repeating themselves three times over.
   */
  const asPeople = useCallback(
    () => [
      { name: client.contact.name ?? "", role: client.contact.role ?? "", email: client.contact.email ?? "" },
      ...[0, 1].map((i) => ({
        name: client.contact.extra?.[i]?.name ?? "",
        role: client.contact.extra?.[i]?.role ?? "",
        email: client.contact.extra?.[i]?.email ?? "",
      })),
    ],
    [client],
  );
  const [people, setPeople] = useState(asPeople);
  const [brokerage, setBrokerage] = useState(client.contact.brokerage ?? "");
  // §6 master-record fields — the OS owns these; nothing is sent to any tool.
  const [accountManager, setAccountManager] = useState(client.record.accountManager ?? "");
  const [salesperson, setSalesperson] = useState(client.record.salesperson ?? "");
  const [sender, setSender] = useState(client.record.sender ?? "");
  const [market, setMarket] = useState(client.record.market ?? "");
  const [mls, setMls] = useState(client.record.mls ?? "");
  const [area, setArea] = useState(client.record.area ?? "");
  const setPerson = (i: number, patch: Partial<(typeof people)[number]>) =>
    setPeople((cur) => cur.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  /*
   * The first line of the introduction as it will really read, from the same
   * function that writes it, so the preview can never promise one thing and
   * the email say another. Anyone half-filled in is left out, which is also
   * what saving refuses.
   */
  const previewPeople =
    introPeopleSentence({
      name: client.name,
      contactName: people[0].name,
      contactRole: people[0].role,
      brokerage: brokerage || null,
      extraContacts: people.slice(1).map((p) => ({ name: p.name, role: p.role })),
    }).replace(/^,\s*|,\s*$/g, "") || "\u2026";

  /*
   * How many contact slots are on screen. Someone who only ever introduces to
   * one person should not have to look at six empty fields, so extra slots
   * appear when they hold something, or when the operator asks for one.
   */
  const [slots, setSlots] = useState(() => {
    const filled = asPeople().filter((p) => p.name.trim() || p.role.trim() || p.email.trim()).length;
    return Math.max(1, filled);
  });
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
      /*
       * Blank is left ALONE rather than sent as 0. A monthly target of zero is
       * a real promise of nothing; an empty box is someone who did not fill it
       * in, and conflating the two would silently zero a live target.
       */
      if (monthlyTarget.trim() !== "" && Number(monthlyTarget) !== client.monthlyTarget) {
        body.monthlyTarget = Number(monthlyTarget);
      }
      if (timezone.trim() !== (client.timezone ?? "")) body.timezone = timezone.trim();
      if (billingInterval) body.billingInterval = billingInterval;
      // Only what changed — an untouched field must not be re-asserted, and a
      // cleared one has to travel as "" so the server knows to null it.
      // Only what actually changed, slot by slot. The first slot keeps the
      // original field names so nothing else has to know it is slot zero.
      const KEYS = [
        { name: "contactName", role: "contactRole", email: "contactEmail" },
        { name: "contact2Name", role: "contact2Role", email: "contact2Email" },
        { name: "contact3Name", role: "contact3Role", email: "contact3Email" },
      ] as const;
      const was = asPeople();
      people.forEach((p, i) => {
        for (const field of ["name", "role", "email"] as const) {
          if (p[field].trim() !== was[i][field].trim()) body[KEYS[i][field]] = p[field].trim();
        }
      });
      if (brokerage.trim() !== (client.contact.brokerage ?? "")) body.brokerage = brokerage.trim();
      // Same rule as every other field here: a key is sent only when its value
      // actually changed, so a blank one is a deliberate clear.
      const RECORD_FIELDS = [
        ["accountManager", accountManager, client.record.accountManager],
        ["salesperson", salesperson, client.record.salesperson],
        ["sender", sender, client.record.sender],
        ["market", market, client.record.market],
        ["mls", mls, client.record.mls],
        ["area", area, client.record.area],
      ] as const;
      for (const [key, next, was] of RECORD_FIELDS) {
        if (next.trim() !== (was ?? "")) body[key] = next.trim();
      }

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
            <span style={LABEL}>Monthly target <span className="mut">· Client Health</span></span>
            <input className="inp tnum" type="number" min={0} value={monthlyTarget}
              placeholder="—"
              onChange={(e) => setMonthlyTarget(e.target.value)} />
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
          Team, agents and DNC. Master Inbox owns these rows and the portal
          writes the same ones, so editing here needs no sync — see
          lib/clients/portal-people-write.ts.
        */}
        <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 13 }}>
          <ClientPeople clientId={client.id} />
        </div>

        {/*
          Time zone gets its own row: an IANA name is long, and the 150px grid
          above would squeeze it. Free text with suggestions rather than a
          closed list — the server validates it against the real zone database,
          so any valid zone works and a typo is refused with the reason.
        */}
        <label style={FIELD}>
          <span style={LABEL}>Time zone <span className="mut">· Client Health</span></span>
          <input
            className="inp"
            list="tz-suggestions"
            value={timezone}
            placeholder="America/New_York"
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="tz-suggestions">
            {[
              "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
              "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
              "Europe/London", "Asia/Kolkata", "UTC",
            ].map((z) => <option key={z} value={z} />)}
          </datalist>
          <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>
            Drives scheduling and every “this week” figure. A wrong zone never errors — it just
            shifts the numbers — so it is checked against the real zone list when you save.
          </span>
        </label>

        {/*
          The §6 master-record fields.

          These are the OS's own — no tool is written when they change, because
          no tool has anywhere to put them. That is precisely why they are
          here: measured 2026-09-24, Account Manager was recorded for 0 clients
          of 46, Sender for 1, MLS and Market for 2 each, Salesperson for 4,
          and Area for none at all. The spec lists all six as master client
          data, and until this dialog there was nowhere to type them.
        */}
        <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 13, display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 650 }}>Client record</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, lineHeight: 1.55 }}>
              Held by the OS and by nothing else. Filling these in is what makes them
              answerable anywhere &mdash; today most are blank for every client.
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <label style={FIELD}>
              <span style={LABEL}>Account manager</span>
              <input className="inp" value={accountManager} maxLength={120}
                onChange={(e) => setAccountManager(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Salesperson</span>
              <input className="inp" value={salesperson} maxLength={120}
                onChange={(e) => setSalesperson(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Sender</span>
              <input className="inp" value={sender} maxLength={120}
                onChange={(e) => setSender(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Market</span>
              <input className="inp" value={market} maxLength={120} placeholder="Phoenix, AZ"
                onChange={(e) => setMarket(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>MLS</span>
              <input className="inp" value={mls} maxLength={120} placeholder="ARMLS"
                onChange={(e) => setMls(e.target.value)} />
            </label>
            <label style={FIELD}>
              <span style={LABEL}>Area</span>
              <input className="inp" value={area} maxLength={120}
                onChange={(e) => setArea(e.target.value)} />
            </label>
          </div>
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
              to <i>{previewPeople}</i> at <i>{brokerage.trim() || client.name}</i>”.
            </div>
          </div>

          <label style={{ ...FIELD, maxWidth: 260 }}>
            <span style={LABEL}>Brokerage</span>
            <input className="inp" value={brokerage} maxLength={160} placeholder={client.name}
              onChange={(e) => setBrokerage(e.target.value)} />
          </label>

          {/*
            One block per person. The client asked to introduce an agent to up
            to three people at once — a team leader, a managing broker and an
            owner, say — all named in the same sentence and all copied in.
            Slots beyond the first appear only when they are wanted.
          */}
          {people.slice(0, slots).map((person, i) => (
            <div key={i} style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--muted)" }}>
                  {["First person", "Second person", "Third person"][i]}
                </span>
                {i > 0 && i === slots - 1 ? (
                  <button type="button" className="btn-ghost" style={{ fontSize: 11.5, padding: "2px 8px" }}
                    onClick={() => {
                      setPerson(i, { name: "", role: "", email: "" });
                      setSlots(i);
                    }}>
                    Remove
                  </button>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                <label style={FIELD}>
                  <span style={LABEL}>Full name</span>
                  <input className="inp" value={person.name} maxLength={160}
                    placeholder={["Nicole Collins", "Shaurs Patel", "Eddy Chen"][i]}
                    onChange={(e) => setPerson(i, { name: e.target.value })} />
                </label>
                <label style={FIELD}>
                  <span style={LABEL}>Their role</span>
                  <input className="inp" value={person.role} maxLength={120}
                    placeholder={["Team Leader", "Managing Broker", "Broker and Owner"][i]}
                    onChange={(e) => setPerson(i, { role: e.target.value })} />
                </label>
                <label style={FIELD}>
                  <span style={LABEL}>Their email</span>
                  <input className="inp" type="email" value={person.email} maxLength={200}
                    placeholder="nicole@brokerage.com"
                    onChange={(e) => setPerson(i, { email: e.target.value })} />
                </label>
              </div>
            </div>
          ))}

          {slots < 3 ? (
            <button type="button" className="btn-ghost"
              style={{ justifySelf: "start", fontSize: 11.5, padding: "3px 9px" }}
              onClick={() => setSlots(slots + 1)}>
              + Add another person
            </button>
          ) : null}

          <span style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 }}>
            Everyone named here goes into the same introduction, and their emails are copied into{" "}
            <b>Cc</b> — added to whoever is already there, never replacing them. A person needs
            both a name and a role to be named.
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
