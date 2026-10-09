"use client";

import { useMemo, useState } from "react";

import { STATUS_MEANING, STATUS_TONE, isClientStatus, statusLabel } from "@/lib/clients/client-status";
import type { DatabaseClient, DatabaseClientsView } from "@/lib/tools/database/clients";

import { Lazy } from "../lazy";
import { Btn } from "../analytics/toast";
import { ClientCountLine } from "@/components/clients/count-line";

/*
 * Database → Clients. §8's Database view, field for field, in its order:
 *
 *   Client · Client status · MLS/location · Campaign · Campaign ID · Leads ·
 *   Sequencers · Replies · Bounces · In Review · Exported · Onboarding status
 *
 * It replaces the standalone Database app's Clients page (/webhooks), which is
 * being retired, and reads the same rows — see lib/tools/database/clients.ts
 * for where each field comes from.
 *
 * Two kinds of blank are kept apart on purpose. "—" means the value is not
 * recorded. "not synced" beside a campaign means its leads never reached the
 * Database — the sync's fetch-failure path — so that client's Sequencers,
 * Replies and Bounces are SHORT, not zero. Reading the second as the first is
 * how an under-counted client passes for a quiet one.
 */

const URL = "/api/tools/agent-search/clients";

type Key =
  | "name" | "status" | "location" | "campaign" | "campaignId" | "leads"
  | "inSequencers" | "replied" | "bounced" | "inReview" | "exported" | "stage";

interface Col {
  key: Key;
  label: string;
  numeric?: boolean;
  /** What sorting and the filter box compare. */
  value: (c: DatabaseClient) => string | number;
}

const campaignNames = (c: DatabaseClient) => c.campaigns.map((x) => x.name || "(unnamed)").join(" ");
const campaignIds = (c: DatabaseClient) => c.campaigns.map((x) => x.id).join(" ");

const COLS: Col[] = [
  { key: "name", label: "Client", value: (c) => c.name },
  { key: "status", label: "Client status", value: (c) => c.status ?? c.toolStatus ?? "" },
  { key: "location", label: "MLS / location", value: (c) => c.location ?? "" },
  { key: "campaign", label: "Campaign", value: campaignNames },
  { key: "campaignId", label: "Campaign ID", value: campaignIds },
  { key: "leads", label: "Leads", numeric: true, value: (c) => c.leads },
  { key: "inSequencers", label: "Sequencers", numeric: true, value: (c) => c.inSequencers ?? -1 },
  { key: "replied", label: "Replies", numeric: true, value: (c) => c.replied ?? -1 },
  { key: "bounced", label: "Bounces", numeric: true, value: (c) => c.bounced ?? -1 },
  { key: "inReview", label: "In Review", value: (c) => (c.inReview ? "yes" : "no") },
  { key: "exported", label: "Exported", value: (c) => (c.exported ? "yes" : "no") },
  { key: "stage", label: "Onboarding status", value: (c) => `${c.stage ?? ""} ${c.progress ? c.progress.pct : ""}` },
];

const none = <span className="api-none">—</span>;
const n = (v: number | null) => (v === null ? none : v.toLocaleString("en-US"));

export function AgentSearchClientsScreen() {
  return (
    <Lazy<DatabaseClientsView> initial={null} url={URL} label="Database clients">
      {(data) => <ClientsTable data={data} />}
    </Lazy>
  );
}

function ClientsTable({ data }: { data: DatabaseClientsView }) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [filters, setFilters] = useState<Partial<Record<Key, string>>>({});
  const [showFilters, setShowFilters] = useState(false);

  const all = data.clients;
  const rows = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v?.trim()) as [Key, string][];
    const out = all.filter((c) =>
      active.every(([k, v]) => String(COLS.find((x) => x.key === k)!.value(c)).toLowerCase().includes(v.trim().toLowerCase())),
    );
    const col = COLS.find((x) => x.key === sort.key)!;
    return out.sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return cmp * sort.dir;
    });
  }, [all, filters, sort]);

  const activeCount = Object.values(filters).filter((v) => v?.trim()).length;
  const unsynced = all.reduce((k, c) => k + c.campaigns.filter((x) => x.leadsSynced === false).length, 0);
  const sum = (f: (c: DatabaseClient) => number | null) => all.reduce((k, c) => k + (f(c) ?? 0), 0);

  return (
    <div className="wrap db-clients">
      <ClientCountLine tool="onboarding" />
      {!data.statsAvailable ? (
        <div className="anno" style={{ marginBottom: 16 }}>
          <b>Sequencers, Replies and Bounces are not available yet.</b> They are counted by a database
          function (Database migration 0123) that has not been created. Leads, campaigns and every other
          column are live.
        </div>
      ) : null}

      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Card label="Clients" value={all.length} sub="in the Database" />
        <Card label="With a campaign" value={all.filter((c) => c.campaigns.length).length} sub={`${sum((c) => c.campaigns.length)} campaigns`} />
        <Card label="Leads built" value={sum((c) => c.leads)} sub={`${all.filter((c) => c.leads > 0).length} clients have leads`} />
        {data.statsAvailable ? (
          <Card
            label="Campaigns not synced"
            value={unsynced}
            sub="no leads reached the Database"
            tone={unsynced > 0 ? "n-risk" : "n-green"}
          />
        ) : (
          <Card label="In review / exported" value={all.filter((c) => c.inReview || c.exported).length} sub="clients flagged" />
        )}
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Clients</div>
            <div className="tbl-sub">
              §8 Database view. Status and markets come from the client record; counts from the Database.
              {data.campaignsSyncedAt ? ` Campaigns last synced ${new Date(data.campaignsSyncedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              {showFilters ? "Hide filters" : "Filter"}
              {activeCount ? ` (${activeCount})` : ""}
            </Btn>
            {activeCount > 0 ? <Btn onClick={() => setFilters({})}>Clear</Btn> : null}
            <span className="tbl-sub tnum">{rows.length} of {all.length} clients</span>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1500 }}>
            <thead>
              <tr>
                {COLS.map((col) => {
                  const on = sort.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className="sortable"
                      onClick={() => setSort((s) => ({ key: col.key, dir: s.key === col.key ? (s.dir === 1 ? -1 : 1) : col.numeric ? -1 : 1 }))}
                      title={`Sort by ${col.label}`}
                      aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                    >
                      {col.label}
                      <span className={`sort-ind${on ? " on" : ""}`}>{on ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</span>
                    </th>
                  );
                })}
              </tr>
              {showFilters ? (
                <tr className="filter-row">
                  {COLS.map((col) => (
                    <th key={col.key}>
                      <input
                        className="inp"
                        type="text"
                        placeholder={`Filter ${col.label.toLowerCase()}…`}
                        aria-label={`Filter ${col.label}`}
                        value={filters[col.key] ?? ""}
                        onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
                      />
                    </th>
                  ))}
                </tr>
              ) : null}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    {all.length === 0 ? "No clients in the Database." : "No client matches these filters."}
                  </td>
                </tr>
              ) : (
                rows.map((c) => <ClientRow key={c.id} c={c} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ClientRow({ c }: { c: DatabaseClient }) {
  return (
    <tr>
      <td>
        {/* The client's record (9 Oct — this linked to the Onboarding page, which was removed). */}
        {c.masterId ? (
          <a
            href={`/roster?client=${c.masterId}`}
            className="cname"
            title={`Open ${c.name}'s client record`}
            style={{ textDecoration: "none", color: "var(--ink)" }}
          >
            {c.name}
          </a>
        ) : (
          <span className="cname" style={{ color: "var(--ink)" }}>{c.name}</span>
        )}
        {!c.masterId ? <div className="cell-sub">no client record</div> : null}
      </td>

      <td>
        {c.status && isClientStatus(c.status) ? (
          <span className={`badge ${STATUS_TONE[c.status]}`} title={STATUS_MEANING[c.status]}>
            {statusLabel(c.status)}
          </span>
        ) : c.toolStatus ? (
          <span className="cell-sub" title="The Database's own value — this client has no client record">{c.toolStatus}</span>
        ) : none}
      </td>

      <td>{c.location ?? none}</td>

      <td>
        {c.campaigns.length === 0 ? none : c.campaigns.map((x) => (
          <div key={`${x.provider}:${x.id}`} className="nowrap">
            {x.name || <span className="api-none">(name not synced)</span>}
            <span className="cell-sub cell-inline">
              {x.provider === "Instantly" ? "Instantly" : "Bison"}
              {x.status ? ` · ${x.status}` : ""}
              {x.leadsSynced === false ? (
                <b style={{ color: "var(--red)" }} title="None of this campaign's leads have reached the Database — its counts are missing, not zero"> · not synced</b>
              ) : null}
            </span>
          </div>
        ))}
      </td>

      <td className="tnum">
        {c.campaigns.length === 0 ? none : c.campaigns.map((x) => <div key={`${x.provider}:${x.id}`}>{x.id}</div>)}
      </td>

      <td className="tnum">{n(c.leads)}</td>
      <td className="tnum">
        {n(c.inSequencers)}
        {c.matched !== null && c.inSequencers ? <div className="cell-sub">{c.matched.toLocaleString("en-US")} matched</div> : null}
      </td>
      <td className="tnum">{n(c.replied)}</td>
      <td className="tnum">{n(c.bounced)}</td>
      <td>{c.inReview ? <span className="badge s-onboarding">In review</span> : <span className="cell-sub">no</span>}</td>
      <td>{c.exported ? <span className="badge s-active">Exported</span> : <span className="cell-sub">no</span>}</td>
      <td>
        {c.stage ?? none}
        {c.progress ? <div className="cell-sub">{c.progress.done} of {c.progress.total} steps · {c.progress.pct}%</div> : null}
      </td>
    </tr>
  );
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
