"use client";

import { useMemo, useState } from "react";

import { PIPELINE_STAGES, type PortalClient, type PortalsData } from "@/lib/tools/master-inbox/portals";
import { dateStamp } from "@/lib/workspace/dates";
import { Lazy, PlaceholderScreen } from "../lazy";

/*
 * Client portals — the staff view.
 *
 * The other half of the introduction loop. Staff label a thread, a trigger
 * puts a row in that client's portal, and the client moves it through their
 * pipeline. This is where staff see what happened next.
 *
 * The screen leads with what is WRONG rather than with totals, because the
 * totals never change and the exceptions are the reason to open it:
 *
 *   a portal that is not live — no token, or switched off, so the client's
 *   link is dead and nobody would know unless they tried it;
 *
 *   a Follow Up Boss push that failed — the introduction is in the portal but
 *   never reached the client's CRM, which is exactly the silent gap the
 *   outbox exists to close;
 *
 *   a client who has not touched their pipeline in weeks.
 *
 * Read-only, and more firmly than elsewhere: these are the tables the 48 live
 * portals are built on.
 */

/** A portal untouched this long is worth asking about. */
const QUIET_DAYS = 21;

type Sort = "attention" | "name" | "activity" | "volume";

export function PortalsScreen({ initial }: { initial: PortalsData | null }) {
  return (
    <Lazy<PortalsData>
      initial={initial}
      url="/api/tools/master-inbox/portals"
      label="Client portals"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {(data) => <PortalsView data={data} />}
    </Lazy>
  );
}

function PortalsView({ data }: { data: PortalsData }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("attention");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [now] = useState(() => Date.now());

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.slug.includes(q));
    if (onlyProblems) list = list.filter((c) => problem(c, now));

    const quiet = (c: PortalClient) => daysSince(c.lastActivityAt, now) ?? 9999;
    return [...list].sort((a, b) => {
      switch (sort) {
        case "name": return a.name.localeCompare(b.name);
        case "activity": return quiet(a) - quiet(b);
        case "volume": return b.total - a.total || a.name.localeCompare(b.name);
        // Anything wrong first, then the quietest.
        default: {
          const pa = problem(a, now) ? 0 : 1;
          const pb = problem(b, now) ? 0 : 1;
          return pa - pb || quiet(b) - quiet(a) || a.name.localeCompare(b.name);
        }
      }
    });
  }, [data.clients, search, sort, onlyProblems, now]);

  if (data.error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Client portals could not be read.</b> {data.error}
        </div>
      </div>
    );
  }

  const notLive = data.clients.filter((c) => !c.live).length;
  const withFailures = data.clients.filter((c) => c.fubFailures > 0).length;
  const quiet = data.clients.filter(
    (c) => c.live && c.total > 0 && (daysSince(c.lastActivityAt, now) ?? 999) >= QUIET_DAYS,
  ).length;

  return (
    <div className="wrap">
      <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <Card label="Live Portals" value={data.livePortals} sub="clients can open these" tone="n-green" />
        <Card label="Not Live" value={notLive} sub="no token, or switched off" tone={notLive > 0 ? undefined : "n-green"} />
        <Card
          label={`Quiet ${QUIET_DAYS}d+`}
          value={quiet}
          sub="client has not touched it"
          tone={quiet > 0 ? "n-risk" : "n-green"}
        />
        <Card
          label="Failed CRM Pushes"
          value={withFailures}
          sub="never reached Follow Up Boss"
          tone={withFailures > 0 ? "n-risk" : "n-green"}
        />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Client Portals</div>
            <div className="tbl-sub">
              {data.totalEntries.toLocaleString("en-US")} introductions across{" "}
              {data.clients.length} clients
              {rows.length !== data.clients.length ? ` · showing ${rows.length}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              placeholder="Search clients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search portals"
            />
            <button
              className={`fp${onlyProblems ? " on" : ""}`}
              onClick={() => setOnlyProblems((v) => !v)}
              aria-pressed={onlyProblems}
              title="Only clients with something wrong"
            >
              Needs attention
            </button>
            <select
              className="inp"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort by"
              style={{ cursor: "pointer" }}
            >
              <option value="attention">Needs attention</option>
              <option value="activity">Quietest first</option>
              <option value="volume">Most introductions</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <th>Client</th>
                <th>Portal</th>
                <th>Introductions</th>
                <th>Hired</th>
                <th>No Show</th>
                <th>Rejected</th>
                <th>Client Activity</th>
                <th>Follow Up Boss</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    {search.trim() ? `Nothing matches “${search.trim()}”.` : "Nothing needs attention."}
                  </td>
                </tr>
              ) : (
                rows.map((c) => <Row key={c.id} c={c} now={now} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 12, lineHeight: 1.7, maxWidth: "88ch" }}>
        Read-only. These are the tables the live portals are built on — a client&rsquo;s
        link stops working the moment its token, its enabled flag or its slug changes,
        so the workspace refuses those writes rather than offering them.
      </p>
    </div>
  );
}

/** Anything a person would want to act on. */
function problem(c: PortalClient, now: number): boolean {
  if (!c.live) return true;
  if (c.fubFailures > 0) return true;
  return c.total > 0 && (daysSince(c.lastActivityAt, now) ?? 999) >= QUIET_DAYS;
}

function Row({ c, now }: { c: PortalClient; now: number }) {
  const days = daysSince(c.lastActivityAt, now);
  const stage = (key: string) => c.byStage[key] ?? 0;

  return (
    <tr>
      <td>
        <div className="cname">{c.name}</div>
        <div className="csince">/{c.slug}</div>
      </td>

      <td>
        {c.live ? (
          <span className="badge s-done"><span className="dot" />Live</span>
        ) : (
          <span
            className="tg"
            style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}
            title={!c.hasToken ? "No portal token" : !c.enabled ? "Portal switched off" : "Not a billable client"}
          >
            {!c.hasToken ? "no token" : !c.enabled ? "switched off" : "not a client"}
          </span>
        )}
      </td>

      <td>{c.total > 0 ? <span className="api-num tnum">{c.total}</span> : <span className="api-none">—</span>}</td>
      <td>{stage("hired") > 0 ? <span className="tnum" style={{ color: "var(--green)", fontWeight: 700 }}>{stage("hired")}</span> : <span className="api-none">—</span>}</td>
      <td>{stage("no_show") > 0 ? <span className="tnum mut">{stage("no_show")}</span> : <span className="api-none">—</span>}</td>
      <td>{stage("we_they_rejected") > 0 ? <span className="tnum mut">{stage("we_they_rejected")}</span> : <span className="api-none">—</span>}</td>

      <td>
        {days === null ? (
          <span className="api-none">never</span>
        ) : days >= QUIET_DAYS ? (
          <span className="tg" style={{ background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }}>
            {days}d ago
          </span>
        ) : (
          <span className="mut">{dateStamp(c.lastActivityAt)}</span>
        )}
      </td>

      <td>
        {c.fubFailures > 0 ? (
          <span
            className="tg"
            style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}
            title="Introductions that never reached this client's CRM"
          >
            {c.fubFailures} failed
          </span>
        ) : c.fubConnected ? (
          <span className="mut" title={`Connected ${dateStamp(c.fubConnectedAt)}`}>connected</span>
        ) : (
          <span className="api-none">not connected</span>
        )}
      </td>
    </tr>
  );
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function Card({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className={`card-n tnum${tone ? ` ${tone}` : ""}`}>{value.toLocaleString("en-US")}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}

export { PIPELINE_STAGES };
