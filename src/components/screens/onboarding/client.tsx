"use client";

import { useCallback, useEffect, useState } from "react";

import type { ClientDetail } from "@/lib/tools/onboarding/client-detail";
import { toneOf } from "@/lib/tools/onboarding/stage-types";
import { initialsOf } from "@/lib/tools/onboarding/people-types";
import { dateStamp, fullStamp } from "@/lib/workspace/dates";
import { PlaceholderScreen } from "../lazy";
import { clientUrl, patchClient, useOnboardingData } from "./actions";
import { Btn, Toast, useToast } from "./toast";
import { Avatar, PhotoInput } from "./photo-input";
import { CustomFields, MlsPicker } from "./client-fields";
import { ClientSteps, PaymentBox } from "./client-steps";
import { ClientAgentsTab, ClientLeadsTab, ClientTeamTab } from "./client-tabs";

/*
 * Onboarding — one client.
 *
 * A port of the orchestrator's `/clients/[id]` page and its three sub-pages,
 * rebuilt in the workspace's own classes. This is the screen where the day-to-day
 * work happens, and until now it was the largest piece of the tool with no
 * address in the OS: the pipeline listed 38 clients and not one of them could be
 * opened.
 *
 * ---------------------------------------------------------------------------
 * WHAT WRITES AND WHAT DOES NOT — the only paragraph that matters here
 *
 * Everything on the left of this screen is LIVE and writes to the orchestrator's
 * own tables: the photo, the stage, the MLS, the custom fields, the salesperson,
 * the account manager, the TAC, and the copy-approval flag. Every one of them is
 * a label — it changes a column and reaches nothing outside this database.
 *
 * The step buttons on the right reach the Client Portal, Client Health, the
 * agent database, EmailBison and Slack, and RUN — with the tool's own guards.
 * The seven email buttons and the Stripe box's send are switched off pending
 * explicit enablement: they validate, say what they would send, and refuse.
 * See client-steps.tsx and lib/tools/onboarding/step-run.ts.
 *
 * As in the tool, opening a client first runs `syncBisonImports()` — the DB-app
 * handshake that picks up "leads imported" flips — so the campaign flags here
 * are as fresh as there.
 */

export type ClientTab = "profile" | "leads" | "agents" | "team";

const TABS: { id: ClientTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "leads", label: "Lead list" },
  { id: "agents", label: "Your agents" },
  { id: "team", label: "Team" },
];

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
  bodyPad = true,
}: {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  bodyPad?: boolean;
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
      <div style={bodyPad ? { padding: "16px 22px 22px" } : undefined}>{children}</div>
    </div>
  );
}

/** One label/value pair in the profile grid. */
function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 170px) 1fr",
        gap: 12,
        alignItems: "start",
        padding: "9px 0",
        borderTop: "1px solid var(--line-soft)",
      }}
    >
      <span style={{ fontSize: 13.5, color: "var(--muted)", fontWeight: 500 }}>{label}</span>
      <div style={{ fontSize: 13.5, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const dash = (v: string | null | undefined) => (v ? <>{v}</> : <span className="api-none">—</span>);

export function OnboardingClientScreen({
  clientId,
  tab = "profile",
  initial = null,
}: {
  clientId: string;
  tab?: ClientTab;
  initial?: ClientDetail | null;
}) {
  const { data, error, reload } = useOnboardingData<ClientDetail>(initial, clientUrl(clientId));

  if (error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>That client could not be loaded.</b> {error}{" "}
          <a href="/onboarding" style={{ color: "inherit", fontWeight: 600 }}>
            Back to the pipeline
          </a>
        </div>
      </div>
    );
  }
  if (!data) return <PlaceholderScreen cards={3} />;
  return <ClientView data={data} tab={tab} reload={reload} />;
}

function ClientView({
  data,
  tab,
  reload,
}: {
  data: ClientDetail;
  tab: ClientTab;
  reload: () => Promise<void>;
}) {
  const c = data.client;
  const { toast, show } = useToast();
  const notify = useCallback(
    (text: string, bad?: boolean) => show({ text, bad }),
    [show],
  );

  /*
   * The tab lives in state AND in the address bar.
   *
   * State, so switching is instant and does not throw away the payload this
   * screen already has. The address too, so a tab can be pasted into Slack and
   * the back button works — `pushState` rather than a router navigation for the
   * same reason the shell uses it: the screen is already mounted, and asking the
   * server for it again would only rebuild what is on screen.
   */
  const [active, setActive] = useState<ClientTab>(tab);
  useEffect(() => setActive(tab), [tab]);
  useEffect(() => {
    function onPop() {
      const last = window.location.pathname.split("/").filter(Boolean).pop();
      setActive(TABS.some((t) => t.id === last) ? (last as ClientTab) : "profile");
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (id: ClientTab) => {
    setActive(id);
    if (typeof window === "undefined") return;
    const base = `/onboarding/clients/${c.id}`;
    const next = id === "profile" ? base : `${base}/${id}`;
    if (window.location.pathname !== next) window.history.pushState({ tab: id }, "", next);
  };

  const stage = data.stages.find((s) => s.id === c.stageId) ?? null;
  const tone = toneOf(stage?.color);
  const counts: Record<ClientTab, number | null> = {
    profile: null,
    leads: data.leadCount,
    agents: data.roster.length + data.dnc.length,
    team: data.team.length,
  };

  return (
    <div className="wrap">
      {data.error && (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Some of this client could not be read.</b> {data.error}
        </div>
      )}

      {/* ------------------------------ header ------------------------------ */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 6 }}>
        <a href="/onboarding" className="btn" style={{ textDecoration: "none" }}>
          ← Pipeline
        </a>
        <PhotoInput
          value={c.photoUrl}
          name={c.name}
          size={52}
          onChange={async (photo) => {
            try {
              await patchClient(c.id, { photo });
              await reload();
              notify(photo ? "Photo saved" : "Photo removed");
            } catch (e) {
              notify(e instanceof Error ? e.message : "Could not save that photo", true);
            }
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="crumb">
            <b>{c.name}</b>
          </div>
          <div className="csince">
            {[...new Set([c.brand, c.officeName].filter((v): v is string => !!v && v !== c.name))].join(" · ") ||
              c.location ||
              " "}
          </div>
        </div>
        {stage && (
          <span className="badge" style={{ background: tone.bg, color: tone.fg }}>
            <span className="dot" />
            {stage.name}
          </span>
        )}
        {!stage && (
          <span className="badge s-risk" title="This client stands on no stage, so it appears on no board">
            <span className="dot" />
            no stage
          </span>
        )}
        {c.healthStatus && (
          <span className={`badge ${c.healthStatus === "active" ? "s-done" : "s-pending"}`}>
            <span className="dot" />
            {c.healthStatus}
          </span>
        )}
        {c.plan && <span className="plan plan-prod">{c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}</span>}
      </div>

      {/* ------------------------------- tabs ------------------------------- */}
      <div className="pills" style={{ margin: "12px 0 20px" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`fp${active === t.id ? " on" : ""}`}
            aria-current={active === t.id ? "page" : undefined}
            data-tab={t.id}
            onClick={() => go(t.id)}
          >
            {t.label}
            {counts[t.id] !== null && (
              <span className="mut" style={{ marginLeft: 6, fontWeight: 500 }}>
                {counts[t.id]?.toLocaleString("en-US")}
              </span>
            )}
          </button>
        ))}
      </div>

      {active === "leads" && <ClientLeadsTab data={data} />}
      {active === "agents" && <ClientAgentsTab data={data} />}
      {active === "team" && <ClientTeamTab data={data} />}
      {active === "profile" && <Profile data={data} notify={notify} reload={reload} />}

      <Toast toast={toast} />
    </div>
  );
}

/* =============================== PROFILE ================================= */

function Profile({
  data,
  notify,
  reload,
}: {
  data: ClientDetail;
  notify: (text: string, bad?: boolean) => void;
  reload: () => Promise<void>;
}) {
  const c = data.client;

  return (
    <>
      {/* The board position. Every stage is clickable, forwards or back —
          moving a client is purely a label; it runs nothing and skips nothing. */}
      <Panel
        title="Stage"
        sub="Click to move this client along the board. It runs nothing and skips nothing."
      >
        <StageRibbon data={data} notify={notify} reload={reload} />
      </Panel>

      <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        <div>
          <Panel
            title="Client"
            sub="From the intake form. The email address is read-only on purpose — it is where every client email is sent."
          >
            <div style={{ marginTop: -9 }}>
              <Kv label="Contact">
                {c.contactName ? (
                  <>
                    {c.contactName}
                    {c.contactRole && <span className="mut"> ({c.contactRole})</span>}
                  </>
                ) : (
                  <span className="api-none">—</span>
                )}
              </Kv>
              <Kv label="Email">
                {c.contactEmail ? (
                  <a href={`mailto:${c.contactEmail}`} style={{ color: "var(--blue)", fontWeight: 600 }}>
                    {c.contactEmail}
                  </a>
                ) : (
                  <span className="api-none">—</span>
                )}
              </Kv>
              <Kv label="Phone">{dash(c.contactPhone)}</Kv>
              <Kv label="MLS">
                <MlsPicker clientId={c.id} current={c.mls} notify={notify} onSaved={reload} />
                <div className="tbl-sub" style={{ marginTop: 6 }}>
                  Clients often name another MLS once the team talks it through — add as many as
                  they recruit in. Nothing re-runs when you change it.
                </div>
              </Kv>
              <Kv label="Location">{dash(c.location)}</Kv>
              <Kv label="Timezone">{dash(c.timezone)}</Kv>
              <Kv label="Onboarding call">
                {c.onboardingCall ?? <span className="api-none">not booked yet</span>}
              </Kv>
              <Kv label="Sender">{dash(c.senderName)}</Kv>
              <Kv label="Sales volume">
                <span className="tnum">
                  ${(c.salesVolumeMin ?? 0).toLocaleString("en-US")} –{" "}
                  {c.salesVolumeMax != null ? `$${c.salesVolumeMax.toLocaleString("en-US")}` : "—"}
                </span>
              </Kv>
              <Kv label="Closed txns">
                <span className="tnum">
                  {c.closedMin ?? 0} – {c.closedMax ?? "—"}
                </span>
              </Kv>
              <Kv label="Added">{dateStamp(c.createdAt)}</Kv>
            </div>
          </Panel>

          <Panel
            title="Custom fields"
            sub="The team's own extras. Nothing in the automation reads them, which is what makes them safe to change at will."
          >
            <CustomFields
              clientId={c.id}
              fields={data.fields}
              knownLabels={data.knownFieldLabels}
              notify={notify}
              onSaved={reload}
            />
          </Panel>

          <Panel title="Who is on this client" sub="Three labels. None of them is read by anything automatic.">
            <SalespersonPicker data={data} notify={notify} reload={reload} />
            <hr style={{ border: 0, borderTop: "1px solid var(--line-soft)", margin: "18px 0" }} />
            <ManagerPicker data={data} notify={notify} reload={reload} />
            <hr style={{ border: 0, borderTop: "1px solid var(--line-soft)", margin: "18px 0" }} />
            <TacPicker data={data} notify={notify} reload={reload} />
          </Panel>
        </div>

        <div>
          <Panel
            title="Actions"
            sub="Every step is manual — run what this client needs, skip what they don't. A ✓ means it already ran."
          >
            <ClientSteps data={data} notify={notify} onSaved={reload} />
          </Panel>

          <Panel title="Payment" sub="Read live from Stripe's own flags on this client.">
            <PaymentBox data={data} />
          </Panel>

          <Panel title="Campaign" sub="What EmailBison has recorded for this client.">
            <div style={{ marginTop: -9 }}>
              <Kv label="Campaign">
                {c.campaignId ? <span className="tnum">#{c.campaignId}</span> : <span className="api-none">not created</span>}
              </Kv>
              <Kv label="Status">
                {c.campaignStatus ? (
                  <span className={`badge ${c.campaignStatus === "active" ? "s-done" : "s-pending"}`}>
                    <span className="dot" />
                    {c.campaignStatus}
                  </span>
                ) : (
                  <span className="api-none">—</span>
                )}
              </Kv>
              <Kv label="Lead list">
                <span className="api-num tnum">{data.leadCount.toLocaleString("en-US")}</span>{" "}
                <span className="mut">leads</span>
                {c.leadsExported ? (
                  <span className="badge s-done" style={{ marginLeft: 8 }}>
                    <span className="dot" />
                    in campaign
                  </span>
                ) : c.leadsInReview ? (
                  <span className="badge s-pending" style={{ marginLeft: 8 }}>
                    <span className="dot" />
                    with the DB app
                  </span>
                ) : null}
              </Kv>
              <Kv label="Portal">
                {c.portalUrl ? (
                  <a
                    href={c.portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--blue)", fontWeight: 600 }}
                  >
                    open the client portal ↗
                  </a>
                ) : (
                  <span className="api-none">not created yet</span>
                )}
              </Kv>
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title={`Client replies (${data.replies.length})`}
        sub="Replies to the onboarding emails, polled from the connected mailbox every 10 minutes."
        bodyPad={false}
      >
        {data.replies.length === 0 ? (
          <div style={{ padding: "30px 22px", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
            No replies tracked yet.
          </div>
        ) : (
          <div className="tbl-scroll">
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>Subject</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {data.replies.map((r) => (
                  <tr key={r.id}>
                    <td className="mut">{fullStamp(r.receivedAt) || "—"}</td>
                    <td>{r.fromEmail ?? "—"}</td>
                    <td>{r.subject ?? "—"}</td>
                    <td className="mut">{(r.snippet ?? "").slice(0, 90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Delivery log"
        sub="The last 20 outbound calls made for this client. This is the same table the ✓ marks are read from; a 'pending' row is an email the OS would have sent, held pending enablement."
        bodyPad={false}
      >
        {data.deliveries.length === 0 ? (
          <div style={{ padding: "30px 22px", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
            No outbound calls yet.
          </div>
        ) : (
          <div className="tbl-scroll">
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Target</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="mut">{fullStamp(d.createdAt) || "—"}</td>
                    <td>{d.target}</td>
                    <td>{d.action}</td>
                    <td>
                      <span
                        className={`badge ${d.status === "ok" ? "s-done" : d.status === "error" ? "s-risk" : "s-pending"}`}
                      >
                        <span className="dot" />
                        {d.status}
                      </span>
                    </td>
                    <td className="mut">{d.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/* ============================ THE PICKERS ================================ */

function StageRibbon({
  data,
  notify,
  reload,
}: {
  data: ClientDetail;
  notify: (text: string, bad?: boolean) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const c = data.client;
  const at = data.stages.findIndex((s) => s.id === c.stageId);

  if (!data.stages.length) {
    return (
      <div className="tbl-sub">
        No stages yet — <a href="/onboarding/stages">create some</a>.
      </div>
    );
  }

  async function move(stageId: string, name: string) {
    setBusy(true);
    try {
      await patchClient(c.id, { stageId });
      await reload();
      notify(`Moved to ${name}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not move that client", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {data.stages.map((s, i) => {
        const here = s.id === c.stageId;
        const passed = at >= 0 && i < at;
        const tone = toneOf(s.color);
        return (
          <button
            key={s.id}
            type="button"
            className={`tg${here ? " on" : ""}`}
            disabled={busy || here}
            data-stage={s.id}
            aria-current={here ? "step" : undefined}
            title={here ? `${s.name} — current stage` : `Move this client to ${s.name}`}
            onClick={() => move(s.id, s.name)}
            style={{
              ...(here ? { background: tone.bg, color: tone.fg, borderColor: "transparent", fontWeight: 700 } : null),
              ...(passed ? { opacity: 0.62 } : null),
              ...(busy && !here ? { opacity: 0.4, cursor: "not-allowed" } : null),
            }}
          >
            <i />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

function SalespersonPicker({
  data,
  notify,
  reload,
}: {
  data: ClientDetail;
  notify: (text: string, bad?: boolean) => void;
  reload: () => Promise<void>;
}) {
  const c = data.client;
  const [name, setName] = useState(c.salespersonName ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(c.salespersonName ?? ""), [c.salespersonName]);

  const changed = name.trim() !== (c.salespersonName ?? "") && !!name.trim();

  return (
    <div>
      <div className="tbl-sub" style={{ fontWeight: 600, color: "var(--ink-2)", marginBottom: 8 }}>
        Salesperson
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Avatar src={c.salespersonPhoto} name={c.salespersonName} size={36} />
        <input
          className="inp"
          list="onb-salespeople"
          value={name}
          disabled={busy}
          placeholder="Type or select a salesperson…"
          aria-label="Salesperson"
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <datalist id="onb-salespeople">
          {data.salespeople.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
        <Btn
          primary
          disabled={busy || !changed}
          onClick={async () => {
            setBusy(true);
            try {
              await patchClient(c.id, { salespersonName: name.trim() });
              await reload();
              notify(`Salesperson set to ${name.trim()}`);
            } catch (e) {
              notify(e instanceof Error ? e.message : "Could not assign that salesperson", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Assign"}
        </Btn>
      </div>
      <div className="tbl-sub" style={{ marginTop: 6 }}>
        An existing name assigns it. A new name creates the salesperson, then assigns.
      </div>
    </div>
  );
}

function ManagerPicker({
  data,
  notify,
  reload,
}: {
  data: ClientDetail;
  notify: (text: string, bad?: boolean) => void;
  reload: () => Promise<void>;
}) {
  const c = data.client;
  const [busy, setBusy] = useState(false);
  const current = data.accountManager;
  /*
   * Someone hidden from the pickers can still be the current holder — a person
   * is hidden rather than deleted when clients are still assigned to them. Keep
   * them selectable, or opening this client would silently blank their manager.
   */
  const options =
    current && !data.accountManagers.some((p) => p.id === current.id)
      ? [current, ...data.accountManagers]
      : data.accountManagers;

  return (
    <div>
      <div className="tbl-sub" style={{ fontWeight: 600, color: "var(--ink-2)", marginBottom: 8 }}>
        Account manager
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Avatar src={current?.photo_url ?? null} name={current?.name} size={36} />
        <select
          className="sel"
          value={current?.id ?? ""}
          disabled={busy}
          aria-label="Account manager"
          style={{ flex: 1, minWidth: 180, opacity: busy ? 0.4 : 1 }}
          onChange={async (e) => {
            const id = e.target.value;
            setBusy(true);
            try {
              await patchClient(c.id, { accountManagerId: id || null });
              await reload();
              notify(id ? `Account manager set to ${options.find((p) => p.id === id)?.name ?? "them"}` : "Account manager cleared");
            } catch (err) {
              notify(err instanceof Error ? err.message : "Could not set the account manager", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">— none —</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.active ? "" : " (hidden)"}
            </option>
          ))}
        </select>
      </div>
      <div className="tbl-sub" style={{ marginTop: 6 }}>
        {data.accountManagers.length === 0 ? (
          <>
            No account managers on the roster yet — <a href="/onboarding/settings">add them in Settings</a>.
          </>
        ) : (
          <>
            Add or edit account managers in <a href="/onboarding/settings">Settings</a>.
          </>
        )}
      </div>
    </div>
  );
}

/*
 * The three TACs the team introduces. A suggestion list rather than a fixed
 * choice — the value is a name dropped into an email body, not a foreign key,
 * and the tool's own list has been out of date before.
 */
const TACS = ["Nicole", "Sara", "Ashley"];

function TacPicker({
  data,
  notify,
  reload,
}: {
  data: ClientDetail;
  notify: (text: string, bad?: boolean) => void;
  reload: () => Promise<void>;
}) {
  const c = data.client;
  const [name, setName] = useState(c.tacName ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(c.tacName ?? ""), [c.tacName]);

  const changed = name.trim() !== (c.tacName ?? "");

  return (
    <div>
      <div className="tbl-sub" style={{ fontWeight: 600, color: "var(--ink-2)", marginBottom: 8 }}>
        Talent acquisition coordinator
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span
          className="badge"
          style={{ background: "var(--inset-2)", color: "var(--ink-2)", minWidth: 34, justifyContent: "center" }}
        >
          {initialsOf(c.tacName)}
        </span>
        <input
          className="inp"
          list="onb-tacs"
          value={name}
          disabled={busy}
          placeholder="Type or select a TAC…"
          aria-label="Talent acquisition coordinator"
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <datalist id="onb-tacs">
          {TACS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <Btn
          primary
          disabled={busy || !changed}
          onClick={async () => {
            setBusy(true);
            try {
              await patchClient(c.id, { tacName: name.trim() });
              await reload();
              notify(name.trim() ? `TAC set to ${name.trim()}` : "TAC cleared");
            } catch (e) {
              notify(e instanceof Error ? e.message : "Could not save the TAC", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save"}
        </Btn>
      </div>
      <div className="tbl-sub" style={{ marginTop: 6 }}>
        Introduced in the “Meet Your Recruiting Team” email. Confirm with the client first.
      </div>
    </div>
  );
}
