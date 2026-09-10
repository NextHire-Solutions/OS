"use client";

import { useState } from "react";

import type { OnboardingSettings } from "@/lib/tools/onboarding/settings-view";
import { STEPS } from "@/lib/tools/onboarding/steps";
import { ROLES, ROLE_LABELS, ROLE_NOUN, type Person, type PersonRole } from "@/lib/tools/onboarding/people-types";
import { PlaceholderScreen } from "../lazy";
import {
  SETTINGS_URL,
  createPerson,
  refreshHealthStatuses,
  removePerson,
  setAutomationEnabled,
  setStepLabels,
  updatePerson,
  useOnboardingData,
} from "./actions";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";
import { Avatar, PhotoInput } from "./photo-input";
import { fullStamp } from "@/lib/workspace/dates";

/*
 * Onboarding — settings.
 *
 * A port of the orchestrator's `/settings` page and its five panels
 * (AutomationSwitch, StepLabelEditor, PeopleEditor ×2, HealthStatusPanel,
 * GoogleConnect), rebuilt in the workspace's own classes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS EDITABLE HERE AND WHAT IS NOT
 *
 * Four of the five panels write for real, to the same `orch_settings` and
 * `orch_salespeople` rows the live orchestrator reads. The automation switch in
 * particular is not a workspace preference: turning it off here stops the
 * orchestrator firing on its next webhook.
 *
 * The fifth — the Gmail mailbox — is READ-ONLY, and says so on screen rather than
 * offering a button that cannot work. Connecting is an OAuth round trip ending at
 * a redirect URI registered with Google for the orchestrator's domain; the
 * workspace is a different origin and holds no client id, so the consent screen
 * would refuse the redirect. See `lib/tools/onboarding/settings-view.ts`.
 */

const CARD: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-lg)",
  boxShadow: "var(--sh-card)",
  marginBottom: 20,
  overflow: "hidden",
};

function Panel({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={CARD}>
      <div className="tbl-head">
        <div>
          <div className="tbl-title">{title}</div>
          {sub && <div className="tbl-sub">{sub}</div>}
        </div>
        {right}
      </div>
      <div style={{ padding: "18px 22px 22px" }}>{children}</div>
    </div>
  );
}

export function OnboardingSettingsScreen({ initial }: { initial: OnboardingSettings | null }) {
  const { data, error, reload } = useOnboardingData<OnboardingSettings>(initial, SETTINGS_URL);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Settings could not be loaded.</b> {error}
        </div>
      </div>
    );
  }
  if (!data) return <PlaceholderScreen cards={3} />;
  return <SettingsView s={data} reload={reload} />;
}

function SettingsView({ s, reload }: { s: OnboardingSettings; reload: () => Promise<void> }) {
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      show({ text: what });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (s.error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Onboarding could not be read.</b> {s.error}. The orchestrator itself is unaffected —
          this is the workspace&rsquo;s connection to its database.
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <AutomationPanel on={s.automationEnabled} busy={busy} run={run} />
      <StepLabelsPanel labels={s.stepLabels} busy={busy} run={run} />

      {ROLES.map((role) => (
        <PeoplePanel
          key={role}
          role={role}
          people={s.people.filter((p) => p.role === role)}
          busy={busy}
          run={run}
        />
      ))}

      <HealthPanel health={s.health} busy={busy} setBusy={setBusy} reload={reload} show={show} />
      <MailboxPanel mailbox={s.mailbox} />

      <Toast toast={toast} />
    </div>
  );
}

/* ------------------------------ pipeline mode ---------------------------- */

function AutomationPanel({
  on,
  busy,
  run,
}: {
  on: boolean;
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <Panel
      title="Pipeline mode"
      sub="Whether the orchestrator does anything on its own, or waits for a person."
      right={
        on ? (
          <span className="badge s-done">
            <span className="dot" />
            automatic
          </span>
        ) : (
          <span className="badge s-pending">
            <span className="dot" />
            manual
          </span>
        )
      }
    >
      <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6, maxWidth: 760 }}>
        {on
          ? "Emails, portal, team, lead list and campaign launch fire on their own as each trigger happens. The buttons on a client page stay available as overrides."
          : "Nothing runs on its own. Every client needs someone to click through the steps on their page — nothing sends unless a person asks for it."}
      </p>
      <ConfirmButton
        label={on ? "Switch to manual" : "Switch to automatic"}
        armedLabel={on ? "Confirm — switch to manual" : "Confirm — switch to automatic"}
        title={
          on
            ? "From now on nothing sends or builds by itself — every step needs a click."
            : "Emails, portal, lead list and campaign launch will start firing on their own again."
        }
        disabled={busy}
        onConfirm={() =>
          void run(on ? "Pipeline is now manual" : "Pipeline is now automatic", () =>
            setAutomationEnabled(!on),
          )
        }
      />
    </Panel>
  );
}

/* ------------------------------ button names ----------------------------- */

function StepLabelsPanel({
  labels,
  busy,
  run,
}: {
  labels: Record<string, string>;
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(labels);
  const dirty = STEPS.some((st) => (draft[st.key] ?? "") !== (labels[st.key] ?? ""));

  return (
    <Panel
      title="Button names"
      sub="Call the step buttons whatever your team calls them. Leave a box empty to keep the default."
      right={
        <div style={{ display: "flex", gap: 8 }}>
          {dirty && (
            <Btn disabled={busy} onClick={() => setDraft(labels)}>
              Cancel
            </Btn>
          )}
          <Btn
            primary
            disabled={busy || !dirty}
            onClick={() => void run("Button names saved", () => setStepLabels(draft))}
          >
            {busy ? "Saving…" : "Save names"}
          </Btn>
        </div>
      }
    >
      <div
        className="anno"
        style={{ margin: "0 0 16px" }}
      >
        <b>These buttons live on a client&rsquo;s own page in the tool.</b> The workspace does not
        carry that page yet, so a name changed here shows up in the orchestrator rather than
        anywhere in the workspace. Saving still works and is what the live tool reads.
      </div>

      <div className="tbl-scroll">
        <table style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Step</th>
              <th style={{ width: 300 }}>Button says</th>
            </tr>
          </thead>
          <tbody>
            {STEPS.map((st) => (
              <tr key={st.key}>
                <td>
                  <div className="cname" style={{ fontSize: 13.5 }}>
                    {st.label}
                  </div>
                  <div className="csince">{st.hint}</div>
                </td>
                <td>
                  <input
                    className="inp"
                    placeholder={st.label}
                    value={draft[st.key] ?? ""}
                    disabled={busy}
                    aria-label={`Button name for ${st.label}`}
                    style={{ width: "100%", minWidth: 160 }}
                    onChange={(e) => setDraft((d) => ({ ...d, [st.key]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* --------------------------------- roster -------------------------------- */

function PeoplePanel({
  role,
  people,
  busy,
  run,
}: {
  role: PersonRole;
  people: Person[];
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);

  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    const payload = { role, name: clean, email, photo };
    setName("");
    setEmail("");
    setPhoto(null);
    void run(`Added ${clean}`, () =>
      createPerson(payload.role, payload.name, payload.email, payload.photo),
    );
  };

  return (
    <Panel
      title={ROLE_LABELS[role]}
      sub="Shown on the pipeline and client pages. Emails use the name only."
      right={
        <span className="badge s-done">
          <span className="dot" />
          {people.filter((p) => p.active).length} active
        </span>
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: 12,
          borderRadius: "var(--r-md)",
          background: "var(--inset)",
          marginBottom: 16,
        }}
      >
        <PhotoInput value={photo} name={name} onChange={setPhoto} disabled={busy} />
        <input
          className="inp"
          placeholder={`New ${ROLE_NOUN[role]}'s name`}
          value={name}
          disabled={busy}
          aria-label={`New ${ROLE_NOUN[role]} name`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <input
          className="inp"
          placeholder="Email (optional)"
          value={email}
          disabled={busy}
          aria-label={`New ${ROLE_NOUN[role]} email`}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Btn primary disabled={busy || !name.trim()} onClick={add}>
          Add
        </Btn>
      </div>

      {people.length === 0 ? (
        <div style={{ padding: "26px 0", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
          No {ROLE_LABELS[role].toLowerCase()} yet.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {people.map((p) => (
            <PersonRow key={p.id} p={p} busy={busy} run={run} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function PersonRow({
  p,
  busy,
  run,
}: {
  p: Person;
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: 12,
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        opacity: p.active ? 1 : 0.6,
      }}
    >
      <PhotoInput
        value={p.photo_url}
        name={p.name}
        disabled={busy}
        onChange={(next) => void run(`Photo updated for ${p.name}`, () => updatePerson(p.id, { photo: next }))}
      />

      <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 200 }}>
        <input
          className="inp"
          key={`${p.id}:name:${p.name}`}
          defaultValue={p.name}
          disabled={busy}
          aria-label={`Name of ${p.name}`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (!next || next === p.name) return;
            void run(`Renamed to ${next}`, () => updatePerson(p.id, { name: next }));
          }}
        />
        <input
          className="inp"
          key={`${p.id}:email:${p.email ?? ""}`}
          defaultValue={p.email ?? ""}
          placeholder="Email (optional)"
          disabled={busy}
          aria-label={`Email of ${p.name}`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next === (p.email ?? "")) return;
            void run(`Email updated for ${p.name}`, () => updatePerson(p.id, { email: next }));
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {!p.active && (
          <>
            <span className="badge s-pending" title="Hidden from the pickers">
              <span className="dot" />
              hidden
            </span>
            <Btn
              disabled={busy}
              onClick={() => void run(`${p.name} restored`, () => updatePerson(p.id, { active: true }))}
            >
              Restore
            </Btn>
          </>
        )}
        <ConfirmButton
          label="Remove"
          armedLabel="Confirm remove"
          title={`Remove ${p.name}? Clients already assigned to them keep the name — they are hidden rather than deleted.`}
          disabled={busy}
          onConfirm={() =>
            void run(`${p.name} removed`, () => removePerson(p.id))
          }
        />
      </div>
    </div>
  );
}

/* ---------------------------- health dashboard --------------------------- */

function HealthPanel({
  health,
  busy,
  setBusy,
  reload,
  show,
}: {
  health: OnboardingSettings["health"];
  busy: boolean;
  setBusy: (b: boolean) => void;
  reload: () => Promise<void>;
  show: (t: { text: string; bad?: boolean }) => void;
}) {
  const total = Object.values(health.counts).reduce((a, b) => a + b, 0);
  const [open, setOpen] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const r = (await refreshHealthStatuses()) as { matched?: number; unmatched?: string[] };
      await reload();
      show({
        text: `Matched ${r.matched ?? 0} clients${
          r.unmatched?.length ? `, ${r.unmatched.length} unmatched` : ""
        }.`,
      });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Refresh failed", bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Health Dashboard"
      sub="Read once a day, and on demand. Nothing here is ever written back to the dashboard."
      right={
        <Btn disabled={busy || !health.configured} onClick={() => void refresh()}>
          {busy ? "Refreshing…" : "Refresh now"}
        </Btn>
      }
    >
      {!health.configured && (
        <div className="anno" style={{ margin: "0 0 16px" }}>
          <b>No credential for the dashboard.</b> Set <code>CLIENT_HEALTH_URL</code> and{" "}
          <code>CLIENT_HEALTH_READ_TOKEN</code> to enable the refresh. The stored statuses below
          still show.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {total > 0 ? (
          <span className="badge s-done">
            <span className="dot" />
            reading {total} clients
          </span>
        ) : (
          <span className="badge s-pending">
            <span className="dot" />
            no statuses yet
          </span>
        )}
        <span className="badge s-done">
          <span className="dot" />
          active {health.counts.active ?? 0}
        </span>
        <span className="badge s-ok">
          <span className="dot" />
          paused {health.counts.paused ?? 0}
        </span>
        <span className="badge s-risk">
          <span className="dot" />
          churned {health.counts.churned ?? 0}
        </span>
      </div>

      <div style={{ fontSize: 13.5, color: "var(--muted)" }}>
        Last refreshed{" "}
        {health.lastSync ? (
          <b style={{ color: "var(--ink-2)" }}>{fullStamp(health.lastSync)}</b>
        ) : (
          <span className="api-none">never</span>
        )}
      </div>

      {health.unmatched.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Btn
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ fontSize: 12.5, padding: "7px 12px" }}
          >
            {open ? "Hide" : "Show"} {health.unmatched.length} client
            {health.unmatched.length === 1 ? "" : "s"} with no match
          </Btn>
          {open && (
            <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
              Matched by name. These show &ldquo;—&rdquo; in the Health column until the names agree
              on both sides: {health.unmatched.join(", ")}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------ email account ---------------------------- */

function MailboxPanel({ mailbox }: { mailbox: OnboardingSettings["mailbox"] }) {
  return (
    <Panel
      title="Email account"
      sub="The Google mailbox the orchestrator sends onboarding emails from and reads replies through."
      right={
        mailbox.email ? (
          <span className="badge s-done">
            <span className="dot" />
            connected
          </span>
        ) : (
          <span className="badge s-risk">
            <span className="dot" />
            not connected
          </span>
        )
      }
    >
      {mailbox.email ? (
        <div style={{ display: "grid", gap: 8, fontSize: 13.5, marginBottom: 14 }}>
          <Row k="Mailbox" v={mailbox.email} />
          <Row k="Sends as" v={mailbox.email} />
          <Row
            k="Reply tracking"
            v={mailbox.hasRefreshToken ? "On (Gmail read)" : "No refresh token stored"}
          />
          {mailbox.connectedAt && (
            <Row k="Connected" v={fullStamp(mailbox.connectedAt)} />
          )}
        </div>
      ) : (
        <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--muted)" }}>
          No account connected. Sends fall back to the service account.
        </p>
      )}

      {/*
        The honest note. The alternative — a Connect button that opens a consent
        screen Google then refuses — is the sort of thing that looks finished and
        is not.
      */}
      <div className="anno" style={{ margin: 0 }}>
        <b>Read-only here.</b> Connecting or disconnecting a mailbox is an OAuth round trip that
        ends at a redirect URI registered with Google for the orchestrator&rsquo;s own domain, so it
        can only be completed there.{" "}
        {mailbox.toolUrl && (
          <a href={`${mailbox.toolUrl}`} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>
            Open Onboarding settings
          </a>
        )}
        {mailbox.hasRefreshToken === false && mailbox.email
          ? " This mailbox has no refresh token stored, so sending is already stopped."
          : ""}
      </div>
    </Panel>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 14 }}>
      <span style={{ width: 130, color: "var(--muted)", flex: "none" }}>{k}</span>
      <span style={{ color: "var(--ink-2)" }}>{v}</span>
    </div>
  );
}
