"use client";

import { useState } from "react";

import type { ClientsOverview, ClientRow } from "@/lib/clients/overview";
import {
  CLIENT_STATUSES,
  STATUS_COLOR_VAR,
  STATUS_MEANING,
  STATUS_TONE,
  statusLabel,
  type ClientStatus,
} from "@/lib/clients/client-status";

import { Lazy, PlaceholderScreen } from "./lazy";
import { OnboardClient } from "./clients-onboard";
import { DeleteClient } from "./clients-delete";
import { EditClient } from "./clients-edit";
import { dateStamp } from "@/lib/workspace/dates";

/*
 * Clients — one row per client, and what each tool knows about them.
 *
 * The roster is the spine. Every row is a client the business has; the columns
 * show what each tool holds for it. A blank cell is a gap in that tool, not a
 * disagreement about who the clients are — which is the entire reason for
 * having a canonical list.
 *
 * The page is deliberately quiet. A client present everywhere draws no
 * attention at all; only genuine gaps are marked, because a screen that
 * highlights everything gets read once.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

function ClientsView({ data, onChanged }: { data: ClientsOverview; onChanged: () => void }) {
  const present = (fn: (r: ClientRow) => boolean) => data.rows.filter(fn).length;

  /*
   * Status filter (§11 asks for status filters as part of one status language).
   *
   * It earns its place now the roster is the COMPLETE client list rather than
   * the active thirty-odd: churned clients are kept forever by design, so
   * without this the people still being served are mixed in with the people
   * who left. Counts are shown on the pills so the distribution is readable
   * without clicking — which is the other half of what §11 asks for.
   */
  const [statusFilter, setStatusFilter] = useState<ClientStatus | "all">("all");
  const countFor = (s: ClientStatus) => data.rows.filter((r) => r.os.status === s).length;
  const rows =
    statusFilter === "all" ? data.rows : data.rows.filter((r) => r.os.status === statusFilter);

  return (
    <>
      <div className="hero" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1>Clients</h1>
          <p>{data.rows.length} clients · what each tool knows about them</p>
        </div>
        <OnboardClient />
      </div>

      <div className="wrap">
        <RecordCoverage rows={data.rows} />

        <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <Card label="Clients" value={data.rows.length} sub="on the roster" />
          <Card
            label="In Client Health"
            value={present((r) => r.health.present)}
            sub="the billed roster"
            tone={present((r) => r.health.present) === data.rows.length ? "n-green" : undefined}
          />
          <Card
            label="In Master Inbox"
            value={present((r) => r.inbox.present)}
            sub="replies attributed"
            tone={present((r) => r.inbox.present) === data.rows.length ? "n-green" : undefined}
          />
          <Card
            label="In Analytics"
            value={present((r) => r.analytics.present)}
            sub="campaign attribution"
            tone={present((r) => r.analytics.present) === data.rows.length ? "n-green" : "n-risk"}
          />
        </div>

        {/*
          Says which list is on screen. The roster fallback renders an identical
          table, so without this a database outage would look like a normal day
          — and every status change would silently fail to save.
        */}
        {data.sourceNote ? (
          <p style={note}>
            <b>Showing the code roster.</b> {data.sourceNote}. Status changes cannot be
            saved until the stored list is available.
          </p>
        ) : null}

        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Client roster</div>
              <div className="tbl-sub">
                The names the business uses. Each tool&rsquo;s own spelling is matched to these.
              </div>
            </div>
            <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <button
                className={`fp${statusFilter === "all" ? " on" : ""}`}
                onClick={() => setStatusFilter("all")}
              >
                All <span className="mut">{data.rows.length}</span>
              </button>
              {CLIENT_STATUSES.map((s) => {
                const n = countFor(s);
                return (
                  <button
                    key={s}
                    className={`fp${statusFilter === s ? " on" : ""}`}
                    // Same colour as the badge, from the same map, so the
                    // filter and the rows it produces cannot look unrelated.
                    style={statusFilter === s ? { color: STATUS_COLOR_VAR[s] } : undefined}
                    onClick={() => setStatusFilter(s)}
                    title={STATUS_MEANING[s]}
                  >
                    {statusLabel(s)} <span className="mut">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tbl-scroll">
            <table style={{ minWidth: 1080 }}>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Plan</th>
                  <th>Status</th>
                  {/* "Onboarding tool", not "Onboarding": this column is
                      presence in that TOOL's intake pipeline, while
                      `onboarding` is now also a lifecycle status. One word for
                      two meanings is what §13 warns against, and the two would
                      sit inches apart on this screen. */}
                  <th>Onboarding tool</th>
                  <th>Weekly target</th>
                  <th>Introductions</th>
                  <th>Last intro</th>
                  <th>Campaigns</th>
                  <th>Sent</th>
                  <th>Portal</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row
                    key={row.client.name}
                    row={row}
                    editable={data.source === "os_clients"}
                    onChanged={onChanged}
                  />
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} style={{ color: "var(--muted)", fontSize: 13 }}>
                      No clients with that status.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {/* Rows a tool holds that are not on the roster. Reported, because one
            is either a client nobody mentioned or a spelling needing an alias —
            and silently dropping either is how a live client disappears. */}
        {(["health", "inbox", "analytics"] as const).map((k) => {
          const tool = data.tools[k];
          if (tool.unavailable) {
            return (
              <p key={k} style={note}>
                <b>{tool.label}</b> could not be read — {tool.unavailable}
              </p>
            );
          }
          if (tool.unknown.length === 0) return null;
          return (
            <p key={k} style={note}>
              <b>{tool.label}</b> holds {tool.unknown.length} entr
              {tool.unknown.length === 1 ? "y" : "ies"} not on the roster:{" "}
              {tool.unknown.join(", ")}. Either a client to add here, or a spelling to
              record as an alias.
            </p>
          );
        })}

        {/* Deliberate non-clients, so nobody mistakes them for clutter. */}
        {Object.values(data.tools).some((t) => t.exempt.length > 0) ? (
          <p style={note}>
            <b>Kept on purpose:</b>{" "}
            {[...new Map(
              Object.values(data.tools).flatMap((t) => t.exempt.map((e) => [e.name, e] as const)),
            ).values()]
              .map((e) => `${e.name} (${e.reason})`)
              .join(", ")}
            .
          </p>
        ) : null}
      </div>
    </>
  );
}

/*
 * How much of the master record actually exists (§6).
 *
 * The spec lists these six as master client data. Before migration 0015 there
 * was nowhere to record any of them, and the measured coverage was: Account
 * Manager 0 of 46, Sender 1, MLS 2, Market 2, Salesperson 4, Area 0.
 *
 * Showing the count rather than a tick makes filling them in a finishing task
 * rather than an open-ended one, and it is the honest answer to "do we have
 * this data" — which, for most of these, is still no.
 *
 * Hidden entirely once every field is complete. A panel that says "all done"
 * forever is a panel people stop seeing.
 */
function RecordCoverage({ rows }: { rows: ClientRow[] }) {
  const FIELDS = [
    ["Account manager", (r: ClientRow) => r.os.record.accountManager],
    ["Salesperson", (r: ClientRow) => r.os.record.salesperson],
    ["Sender", (r: ClientRow) => r.os.record.sender],
    ["Market", (r: ClientRow) => r.os.record.market],
    ["MLS", (r: ClientRow) => r.os.record.mls],
    ["Area", (r: ClientRow) => r.os.record.area],
  ] as const;

  const total = rows.length;
  const counts = FIELDS.map(([label, get]) => ({
    label,
    n: rows.filter((r) => (get(r) ?? "").trim()).length,
  }));
  if (total === 0 || counts.every((c) => c.n === total)) return null;

  return (
    <div style={{ ...note, marginTop: 0, marginBottom: 14, maxWidth: "none" }}>
      <b>Client record</b> — the fields the architecture spec asks the master record to
      hold. Recorded on the Edit dialog; held by the OS and by no other tool.
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 7 }}>
        {counts.map((c) => (
          <span key={c.label} className="tnum">
            {c.label}{" "}
            <b style={{ color: c.n === 0 ? "var(--red)" : c.n === total ? "var(--green)" : "var(--yellow)" }}>
              {c.n}/{total}
            </b>
          </span>
        ))}
      </div>
    </div>
  );
}

const note: React.CSSProperties = {
  fontSize: 12.5,
  color: "var(--muted)",
  marginTop: 12,
  lineHeight: 1.7,
  maxWidth: "90ch",
};

/**
 * "Introduction ready", with how many people it names.
 *
 * A person counts only when they have both a name and a role, which is the
 * same rule the macro itself applies — so this chip says exactly what the
 * introduction will do, not what has been typed into the form.
 */
function IntroChip({ contact }: { contact: ClientRow["os"]["contact"] }) {
  const people = [
    { name: contact.name, role: contact.role },
    ...(contact.extra ?? []).map((p) => ({ name: p.name, role: p.role })),
  ].filter((p) => (p.name ?? "").trim() && (p.role ?? "").trim());
  if (people.length === 0) return null;

  const named = people.map((p) => `${p.name} (${p.role})`).join(", ");
  return (
    <span
      className="cintro"
      title={`Introduces to ${named}${contact.brokerage ? ` at ${contact.brokerage}` : ""}`}
    >
      <span className="dot" />
      Introduction ready
      {people.length > 1 ? <span className="n">· {people.length} people</span> : null}
    </span>
  );
}

function Row({ row, editable, onChanged }: { row: ClientRow; editable: boolean; onChanged: () => void }) {
  const { client, health, inbox, analytics, os, portalUrl } = row;
  return (
    <tr>
      <td>
        <div className="cname">{client.name}</div>
        {/*
          Who this client introduces agents to.
          --------------------------------------------------------------
          Until now the only way to know whether a client's Introduce
          button would work was to open a conversation and look at it.
          Drawn only when the details ARE there: most clients do not have
          them yet, and a chip on every row would drown the table.
        */}
        <IntroChip contact={os.contact} />
      </td>

      <td>
        {health.plan ? (
          <span className={`plan ${PLAN_CLASS[health.plan] ?? "plan-min"}`}>
            {health.plan.charAt(0).toUpperCase() + health.plan.slice(1)}
          </span>
        ) : (
          <Gap tool="Client Health" />
        )}
      </td>

      {/*
        The status the BUSINESS set, not the one Client Health derives. They can
        disagree — a client paused in the OS may still be active there — and the
        disagreement is worth seeing, so it is marked rather than hidden or
        silently overwritten.
      */}
      <td>
        <StatusCell
          id={os.id}
          status={os.status}
          editable={editable}
          healthStatus={health.status}
        />
        {/* §12: when this status was set. A seeded row is the status we
            FOUND, not a change on that date — the wording distinguishes
            them, because dating an old churn to the client's creation date
            would be wrong in a way that looks precise. */}
        {os.statusSince ? (
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
            {os.statusSince.recorded ? "known since " : ""}
            {dateStamp(os.statusSince.at)}
            {os.statusSince.from ? (
              <span title={`Changed from ${os.statusSince.from}`}> · from {os.statusSince.from}</span>
            ) : null}
          </div>
        ) : null}
      </td>

      <td>
        {os.inOnboarding ? (
          <span className="badge s-done"><span className="dot" />In pipeline</span>
        ) : (
          <span className="api-none" title="No row in the Onboarding tool. Not a problem — only clients that came through intake have one.">—</span>
        )}
      </td>

      <td>{health.weeklyTarget === null ? <span className="api-none">—</span> : <span className="tnum">{health.weeklyTarget}</span>}</td>

      <td>
        {inbox.present ? (
          <span className="api-num tnum">{(inbox.intros ?? 0).toLocaleString("en-US")}</span>
        ) : (
          <Gap tool="Master Inbox" />
        )}
      </td>

      <td className="mut">{inbox.lastIntro ? dateStamp(inbox.lastIntro) : "—"}</td>

      <td>
        {analytics.present ? (
          <span className="tnum">{analytics.campaigns ?? 0}</span>
        ) : (
          <Gap tool="Analytics" />
        )}
      </td>

      <td>{analytics.sent === null ? <span className="api-none">—</span> : <span className="tnum">{analytics.sent.toLocaleString("en-US")}</span>}</td>

      {/*
        The portal link. Opens in a new tab because it is a DIFFERENT product —
        a login-free client-facing page on another host — and losing the roster
        to navigate there is not what anyone means by clicking it.
      */}
      <td>
        {portalUrl ? (
          <a
            href={portalUrl}
            target="_blank"
            rel="noreferrer"
            className="mut"
            style={{ fontSize: 12, color: "var(--blue)", whiteSpace: "nowrap" }}
            title={portalUrl}
          >
            Open ↗
          </a>
        ) : (
          <span className="api-none" title="This client has no portal. Onboarding creates one; a client adopted from another tool may not have.">—</span>
        )}
      </td>

      {/*
        The row action. Deliberately last, unlabelled and quiet: it is the one
        irreversible control on the screen, and it must not sit where a cursor
        lands by accident. Only available once the client has a stored record —
        there is nothing to remove otherwise.
      */}
      <td style={{ textAlign: "right" }}>
        {editable && os.id ? (
          <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
            <EditClient
              client={{
                id: os.id,
                name: client.name,
                aliases: client.aliases ?? [],
                status: os.status,
                plan: health.plan,
                weeklyTarget: health.weeklyTarget,
                monthlyTarget: health.monthlyTarget,
                timezone: health.timezone,
                contact: os.contact,
                record: os.record,
              }}
              onSaved={onChanged}
            />
            <DeleteClient id={os.id} name={client.name} onDeleted={onChanged} />
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/*
 * The status cell, editable in place.
 *
 * ---------------------------------------------------------------------------
 * WHY A SELECT AND NOT A MENU OF ACTIONS
 *
 * Because every value is reachable from every other one. A client marked
 * churned in error must be as easy to set back to active as it was to change —
 * there is no delete anywhere in this feature, and status is the only thing
 * that moves, so it is a field rather than a decision.
 *
 * Saving is optimistic: the new value paints immediately and reverts if the
 * write fails. A cell that sat on "saving…" would invite a second click, and
 * the second click is how someone changes a status twice by accident.
 *
 * Changing this does NOT pause billing, disable a portal or stop a campaign.
 * It records what the business says. Those remain deliberate acts in the tools
 * that own them, which is why nothing here contacts a tool.
 */
function StatusCell({
  id,
  status,
  editable,
  healthStatus,
}: {
  id: string | null;
  status: ClientStatus;
  editable: boolean;
  healthStatus: string | null;
}) {
  const [value, setValue] = useState<ClientStatus>(status);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");

  async function change(next: ClientStatus) {
    if (!id || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    setFailed("");
    try {
      const res = await fetch("/api/workspace/clients/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      // Put it back. Showing the new value after a failed write would be a
      // lie that survives until the next reload.
      setValue(previous);
      setFailed(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (!editable || !id) {
    return (
      <span className={`badge ${STATUS_TONE[value]}`} title={STATUS_MEANING[value]}>
        <span className="dot" />
        {statusLabel(value)}
      </span>
    );
  }

  /*
   * Client Health derives its own status from its own flags. When the two
   * disagree that is worth seeing — it usually means someone paused a client
   * in one place and not the other — so it is noted beside the field rather
   * than resolved by guessing which is right.
   */
  const disagrees = healthStatus && healthStatus !== value;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <select
        className="inp"
        value={value}
        disabled={saving}
        aria-label="Client status"
        style={{
          padding: "3px 6px", fontSize: 12.5, minWidth: 96,
          opacity: saving ? 0.6 : 1,
          /*
           * The control carries the same colour as the badge, from the same
           * map — so the editable and read-only views of one status can never
           * disagree about what it looks like (§11).
           */
          borderColor: value === "active" ? undefined : STATUS_COLOR_VAR[value],
          color: STATUS_COLOR_VAR[value],
        }}
        title={STATUS_MEANING[value]}
        onChange={(e) => void change(e.target.value as ClientStatus)}
      >
        {CLIENT_STATUSES.map((s) => (
          <option key={s} value={s}>{statusLabel(s)}</option>
        ))}
      </select>
      {disagrees ? (
        <span
          className="mut"
          style={{ fontSize: 11 }}
          title={`Client Health has this client as "${healthStatus}". Neither is changed by the other.`}
        >
          CH: {healthStatus}
        </span>
      ) : null}
      {failed ? <span style={{ fontSize: 11, color: "var(--red)" }} title={failed}>not saved</span> : null}
    </span>
  );
}

/** A client a tool does not have. Named, so the reader knows what to fix. */
function Gap({ tool }: { tool: string }) {
  return (
    <span
      className="tg"
      style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}
      title={`Not set up in ${tool}`}
    >
      missing
    </span>
  );
}

function Card({
  label, value, sub, tone,
}: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className={`card-n tnum${tone ? ` ${tone}` : ""}`}>{value}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}

/*
 * The public screen. `initial` is set only when the page was opened here —
 * then it server-renders with no loading state and no second round trip.
 * Otherwise it fetches on first visit and stays mounted, so returning to it is
 * instant. See `Lazy` for why every route no longer pays for this data.
 */
export function ClientsScreen({ initial }: { initial: ClientsOverview | null }) {
  return (
    <Lazy<ClientsOverview>
      initial={initial}
      url="/api/workspace/roster"
      label="The client roster"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {/*
        A delete or an onboard changes the list, so the screen re-reads rather
        than patching its own copy — the table shows what each TOOL holds, and
        only a refetch can know that.
      */}
      {(d) => <ClientsView data={d} onChanged={() => window.location.reload()} />}
    </Lazy>
  );
}
