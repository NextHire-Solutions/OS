"use client";

import { useEffect, useState } from "react";

import type { OnboardingSettings } from "@/lib/tools/onboarding/settings-view";
import { STEPS } from "@/lib/tools/onboarding/steps";
import { ROLES, ROLE_LABELS, ROLE_NOUN, type Person, type PersonRole } from "@/lib/tools/onboarding/people-types";
import { PlaceholderScreen } from "../lazy";
import {
  SETTINGS_URL,
  createPerson,
  disconnectMailbox,
  pollRepliesNow,
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
 * All five panels write for real, to the same `orch_settings`,
 * `orch_salespeople` and `orch_email_account` rows. The automation switch is
 * not a preference: on, the OS runs the set-up chain on copy approval, records
 * the Calendly-triggered emails as pending, and launches a campaign when the
 * DB app imports its leads; off, every step waits for a button.
 *
 * The Gmail mailbox panel is the tool's GoogleConnect: Connect starts the OAuth
 * round trip at /api/tools/onboarding/auth/google, Google returns to this
 * workspace's own callback, and Check-replies-now READS the mailbox. Sending
 * from it is switched off pending explicit enablement.
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
      <MailboxPanel mailbox={s.mailbox} busy={busy} run={run} show={show} />
      <SchedulerNote scheduler={s.scheduler} />

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
          ? "Approving the copy runs the set-up chain — portal, team, Health Dash, campaign, lead list — and the campaign launches when the DB app imports its leads. The client emails those triggers would send are recorded as pending enablement, not sent. The buttons on a client page stay available as overrides."
          : "Nothing runs on its own. Every client needs someone to click through the steps on their page — nothing builds or launches unless a person asks for it."}
      </p>
      <ConfirmButton
        label={on ? "Switch to manual" : "Switch to automatic"}
        armedLabel={on ? "Confirm — switch to manual" : "Confirm — switch to automatic"}
        title={
          on
            ? "From now on nothing builds or launches by itself — every step needs a click."
            : "Copy approval will run the set-up chain, and campaigns will launch when their leads are imported. Emails stay switched off."
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
        <b>These names appear on every client&rsquo;s page.</b> Rename a step here and the
        button changes both in the workspace &mdash; Onboarding &rsaquo; Pipeline, then any
        client &mdash; and in the live orchestrator, which reads the same setting.
        {/*
          * This note used to say the workspace "does not carry that page yet", which
          * was true when it was written and is not now: `/onboarding/clients/<id>` is
          * a real screen, and `client-steps.tsx` labels its buttons through
          * `labelFor(step, data.stepLabels)` — the very values this table edits. A
          * caveat that has outlived its cause is worse than none, because it tells
          * the reader their change went nowhere.
          */}
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
          <b>No credential for the dashboard.</b> Set <code>CLIENT_HEALTH_SUPABASE_URL</code> and{" "}
          <code>CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY</code> to enable the refresh. The stored statuses below
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

function MailboxPanel({
  mailbox,
  busy,
  run,
  show,
}: {
  mailbox: OnboardingSettings["mailbox"];
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
  show: (t: { text: string; bad?: boolean }) => void;
}) {
  /*
   * Google sends the browser back to /onboarding/settings?connected=<email> or
   * ?error=<why> (the tool's callback does the same to /settings). Read it once,
   * say it, and clean the address so a reload does not say it again.
   */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get("connected");
    const error = q.get("error");
    if (!connected && !error) return;
    show(connected ? { text: `Connected ${connected}` } : { text: `Connection error: ${error}`, bad: true });
    window.history.replaceState(null, "", window.location.pathname);
  }, [show]);

  const connected = !!mailbox.email;
  const badge = !connected ? (
    <span className="badge s-risk"><span className="dot" />not connected</span>
  ) : mailbox.broken ? (
    <span className="badge s-risk"><span className="dot" />connection broken</span>
  ) : (
    <span className="badge s-done"><span className="dot" />connected</span>
  );

  const connectButton = (
    <a
      href={mailbox.connectUrl}
      className="btn btn-pri"
      aria-disabled={!mailbox.configured}
      title={mailbox.configured ? "Opens Google's consent screen for the mailbox" : "Set the Google OAuth client id and secret first"}
      onClick={(e) => { if (!mailbox.configured) e.preventDefault(); }}
      style={mailbox.configured ? undefined : { opacity: 0.4, cursor: "not-allowed" }}
    >
      {connected ? "Reconnect Google account" : "Connect Google account"}
    </a>
  );

  return (
    <Panel
      title="Email account"
      sub="The Google mailbox the onboarding emails are sent from and replies are read through."
      right={badge}
    >
      {!mailbox.configured && (
        <div className="anno" style={{ margin: "0 0 16px" }}>
          <b>Waiting on the Google OAuth client.</b> Set <code>ONBOARDING_GOOGLE_OAUTH_CLIENT_ID</code> and{" "}
          <code>ONBOARDING_GOOGLE_OAUTH_CLIENT_SECRET</code> in the environment, then reload to enable Connect.
        </div>
      )}

      {connected && mailbox.broken && (
        <div className="anno" style={{ margin: "0 0 16px", borderColor: "var(--red)" }}>
          <div>
            <b style={{ color: "var(--red)" }}>Connection broken — reply tracking is stopped.</b>{" "}
            {mailbox.invalidGrant
              ? "Google revoked this mailbox's access (token revoked — password change, revoked access, or the OAuth app in Testing mode)."
              : mailbox.error}{" "}
            Reconnect below.
          </div>
        </div>
      )}

      {connected ? (
        <div style={{ display: "grid", gap: 8, fontSize: 13.5, marginBottom: 14 }}>
          <Row k="Mailbox" v={mailbox.email ?? ""} />
          <Row k="Sends as" v={mailbox.email ?? ""} />
          <Row
            k="Reply tracking"
            v={mailbox.broken ? "Stopped" : mailbox.hasRefreshToken ? "On (Gmail read, every 10 minutes)" : "No refresh token stored"}
          />
          <Row k="Sending" v="Switched off in the OS pending explicit enablement" />
          {mailbox.connectedAt && <Row k="Connected" v={fullStamp(mailbox.connectedAt)} />}
          {mailbox.checkedAt && <Row k="Last checked" v={fullStamp(mailbox.checkedAt)} />}
        </div>
      ) : (
        <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--muted)" }}>
          No account connected yet. Reply tracking needs one.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {connected && !mailbox.broken ? (
          <Btn
            disabled={busy}
            title="Reads the inbox for replies on threads the onboarding emails started. Sends nothing."
            onClick={() =>
              void (async () => {
                try {
                  const r = await pollRepliesNow();
                  show({ text: `Scanned ${r.scanned ?? 0} inbox messages, matched ${r.matched ?? 0} replies.` });
                } catch (e) {
                  show({ text: e instanceof Error ? e.message : "Poll failed", bad: true });
                }
              })()
            }
          >
            Check replies now
          </Btn>
        ) : (
          connectButton
        )}
        {connected && !mailbox.broken && connectButton}
        {connected && (
          <>
            <span style={{ flex: 1 }} />
            <ConfirmButton
              label="Disconnect"
              armedLabel="Confirm disconnect"
              title="Forget this Google account. Reply tracking stops until another is connected."
              disabled={busy}
              onConfirm={() => void run("Google account disconnected", disconnectMailbox)}
            />
          </>
        )}
      </div>

      <p style={{ marginTop: 14, fontSize: 12.5, color: "var(--muted)" }}>
        Redirect URI to register in Google Cloud: <code>{mailbox.redirectUri}</code>
      </p>
    </Panel>
  );
}

/* ------------------------------- scheduler -------------------------------- */

function SchedulerNote({ scheduler }: { scheduler: OnboardingSettings["scheduler"] }) {
  return (
    <Panel
      title="Background jobs"
      sub="Reply polling, the DB-app import check, the daily Health Dash refresh, the follow-up clock and the cancelled-call alert — every 10 minutes."
      right={
        scheduler.running ? (
          <span className="badge s-done"><span className="dot" />running</span>
        ) : scheduler.enabled ? (
          <span className="badge s-pending"><span className="dot" />starts on first request</span>
        ) : (
          <span className="badge s-risk"><span className="dot" />off</span>
        )
      }
    >
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6 }}>
        {scheduler.enabled
          ? scheduler.running
            ? `In-process ticker running since ${fullStamp(scheduler.startedAt)}.`
            : "ONBOARDING_CRON_ENABLED=1 is set; the ticker starts with the first onboarding request after boot."
          : "Set ONBOARDING_CRON_ENABLED=1 on exactly one process to run these in-process, or drive /api/tools/onboarding/cron/* from an external scheduler with the bearer secret."}
      </p>
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
