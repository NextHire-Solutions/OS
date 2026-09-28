"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ClientsOverview, ClientRow } from "@/lib/clients/overview";
import { CLIENT_STATUSES, STATUS_MEANING, statusLabel, type ClientStatus } from "@/lib/clients/client-status";
import { dayStamp } from "@/lib/workspace/dates";

import { Badge, PageHeader, Panel, SearchInput, Stat, Stats } from "@/components/ds";
import { invalidate, loadOnce, PlaceholderScreen } from "./lazy";
import { OnboardClient } from "./clients-onboard";
import { ClientRecord, STATUS_BADGE, intervalLabel, planLabel } from "./client-record";

/*
 * Clients — one row per client, and what each tool knows about them.
 *
 * Rebuilt on the design system (29 Sep) after the client's review: full width,
 * one header, status tiles that double as the filter, a table you can sort, and
 * a record panel that edits in place. The roster is still the spine — every row
 * is a client the business has, and a blank cell is a gap in a tool, not a
 * disagreement about who the clients are.
 */

const URL = "/api/workspace/roster";

type SortKey = "name" | "status" | "plan" | "monthly" | "billing" | "intros" | "last" | "campaigns" | "sent" | "markets";

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n.toLocaleString("en-US");

const STATUS_ORDER: Record<ClientStatus, number> = { onboarding: 0, active: 1, paused: 2, churned: 3 };

const SORTS: Record<SortKey, (r: ClientRow) => string | number> = {
  name: (r) => r.client.name.toLowerCase(),
  status: (r) => STATUS_ORDER[r.os.status],
  plan: (r) => r.health.plan ?? "",
  monthly: (r) => r.health.monthlyTarget ?? -1,
  billing: (r) => r.health.nextBillingDate ?? "9999",
  intros: (r) => r.inbox.intros ?? -1,
  last: (r) => r.inbox.lastIntro ?? "",
  campaigns: (r) => r.analytics.campaigns ?? -1,
  sent: (r) => r.analytics.sent ?? -1,
  markets: (r) => r.os.markets?.count ?? -1,
};

function ClientsView({ data, onChanged }: { data: ClientsOverview; onChanged: () => void }) {
  const [statusFilter, setStatusFilter] = useState<ClientStatus | "all">("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [openName, setOpenName] = useState<string | null>(null);

  const countFor = (s: ClientStatus) => data.rows.filter((r) => r.os.status === s).length;
  const everywhere = data.rows.filter((r) => r.health.present && r.inbox.present && r.analytics.present).length;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = data.rows.filter((r) =>
      (statusFilter === "all" || r.os.status === statusFilter) &&
      (!needle || [r.client.name, ...(r.client.aliases ?? [])].some((n) => n.toLowerCase().includes(needle))),
    );
    const get = SORTS[sort.key];
    return out.sort((a, b) => {
      const x = get(a), y = get(b);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [data.rows, statusFilter, q, sort]);

  const open = openName ? data.rows.find((r) => r.client.name === openName) ?? null : null;
  const editable = data.source === "os_clients";

  const Th = ({ k, children, num }: { k: SortKey; children: React.ReactNode; num?: boolean }) => {
    const on = sort.key === k;
    return (
      <th className={`sortable${num ? " num" : ""}`} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : num ? -1 : 1 }))}>
        {children}{on ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </th>
    );
  };

  return (
    <div className="ds-page">
      <PageHeader
        title="Clients"
        description={`${data.rows.length} clients — the one list every tool reads from. Open a client to see and edit everything about them.`}
        actions={<OnboardClient />}
      />

      <Stats>
        <Stat label="All clients" value={data.rows.length} sub={`${everywhere} in every tool`}
          onClick={() => setStatusFilter("all")} active={statusFilter === "all"} />
        {CLIENT_STATUSES.map((s) => (
          <Stat key={s} label={statusLabel(s)} value={countFor(s)} title={STATUS_MEANING[s]}
            tone={s === "active" ? "green" : s === "paused" ? "amber" : s === "churned" ? "red" : "brand"}
            sub={s === "onboarding" ? "being set up" : s === "active" ? "being served" : s === "paused" ? "on hold" : "left"}
            onClick={() => setStatusFilter(statusFilter === s ? "all" : s)} active={statusFilter === s} />
        ))}
      </Stats>

      <MissingData rows={data.rows} />

      {data.sourceNote ? (
        <p className="ds-note">
          <b>Showing the code roster.</b> {data.sourceNote}. Changes cannot be saved until the stored list is available.
        </p>
      ) : null}

      <Panel
        flush
        title={statusFilter === "all" ? "All clients" : `${statusLabel(statusFilter)} clients`}
        actions={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search clients or aliases" label="Search clients" />
            <span className="ds-count">{rows.length} of {data.rows.length}</span>
          </>
        }
      >
        <div className="ds-table-scroll">
          <table className="ds-table" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <Th k="name">Client</Th>
                <Th k="status">Status</Th>
                <Th k="plan">Plan</Th>
                <Th k="monthly" num>Monthly target</Th>
                <Th k="billing">Next billing</Th>
                <Th k="intros" num>Introductions</Th>
                <Th k="campaigns" num>Campaigns</Th>
                <Th k="markets" num>Markets</Th>
                <th>Portal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.client.name} row={row} onOpen={() => setOpenName(row.client.name)} />
              ))}
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="ds-none" style={{ padding: 28, textAlign: "center" }}>No client matches.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <ToolNotes data={data} />

      {open ? (
        <ClientRecord row={open} open editable={editable} onClose={() => setOpenName(null)} onChanged={onChanged}
          onDeleted={() => { setOpenName(null); onChanged(); }} />
      ) : null}
    </div>
  );
}

/*
 * What the master record is still missing, in one quiet line. Hidden once
 * complete — a panel that says "all done" forever is a panel people stop seeing.
 * Markets count from os.markets (migration 0017), not the retired single fields.
 */
function MissingData({ rows }: { rows: ClientRow[] }) {
  const total = rows.length;
  const has = (s: string | null) => Boolean((s ?? "").trim());
  const gaps = [
    ["account manager", rows.filter((r) => !has(r.os.record.accountManager)).length],
    ["sender", rows.filter((r) => !has(r.os.record.sender)).length],
    ["markets", rows.filter((r) => (r.os.markets?.count ?? 0) === 0).length],
    ["salesperson", rows.filter((r) => !has(r.os.record.salesperson)).length],
    ["Stripe subscription", rows.filter((r) => !has(r.os.record.stripeSubscriptionId) && r.os.status === "active").length],
  ].filter(([, n]) => (n as number) > 0) as [string, number][];
  if (!total || !gaps.length) return null;
  return (
    <p className="ds-note info" style={{ margin: 0 }}>
      <b>Still to fill in:</b>{" "}
      {gaps.map(([label, n], i) => (
        <span key={label}>{i ? " · " : ""}{label} for {n} client{n === 1 ? "" : "s"}</span>
      ))}
      . Open a client to add them.
    </p>
  );
}

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
    <Badge tone="green" dot title={`Introduces to ${named}${contact.brokerage ? ` at ${contact.brokerage}` : ""}`}>
      Introduction ready{people.length > 1 ? ` · ${people.length} people` : ""}
    </Badge>
  );
}


function Row({ row, onOpen }: { row: ClientRow; onOpen: () => void }) {
  const { client, health, inbox, analytics, os, portalUrl } = row;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const missing = (tool: string) => <Badge tone="red" title={`Not set up in ${tool}`}>missing</Badge>;
  return (
    <tr className="clickable" onClick={onOpen}>
      <td className="wrap" style={{ minWidth: 200 }}>
        <button type="button" className="ds-primary" onClick={(e) => { e.stopPropagation(); onOpen(); }}
          style={{ all: "unset", cursor: "pointer", fontWeight: 600, color: "var(--ds-ink)" }}
          title="Open the client record">
          {client.name}
        </button>
        <span className="ds-sub" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <IntroChip contact={os.contact} />
          {(client.aliases ?? []).length ? <span title={(client.aliases ?? []).join(", ")}>{(client.aliases ?? []).length} alias{(client.aliases ?? []).length === 1 ? "" : "es"}</span> : null}
        </span>
      </td>
      <td>
        <Badge tone={STATUS_BADGE[os.status]} dot title={STATUS_MEANING[os.status]}>{statusLabel(os.status)}</Badge>
      </td>
      <td>{health.plan ? <Badge tone="violet">{planLabel(health.plan)}</Badge> : missing("Client Health")}</td>
      <td className="num">{health.monthlyTarget ?? <span className="ds-none">—</span>}</td>
      <td>
        {health.nextBillingDate ? dayStamp(health.nextBillingDate) : <span className="ds-none">{health.billingAnchorDate ? "—" : "No anchor date"}</span>}
        <span className="ds-sub" title={os.record.stripeSubscriptionId ? `Stripe ${os.record.stripeSubscriptionId}` : "No Stripe subscription linked — a status change will not touch billing"}>
          {intervalLabel(health.billingInterval) ?? "—"}
          {os.record.stripeSubscriptionId ? " · Stripe" : " · no Stripe"}
        </span>
      </td>
      <td className="num">
        {inbox.present ? <span className="ds-primary">{(inbox.intros ?? 0).toLocaleString("en-US")}</span> : missing("Master Inbox")}
        {inbox.lastIntro ? <span className="ds-sub">last {dayStamp(inbox.lastIntro)}</span> : null}
      </td>
      <td className="num">
        {analytics.present ? analytics.campaigns ?? 0 : missing("Analytics")}
        {analytics.sent ? <span className="ds-sub" title={`${analytics.sent.toLocaleString("en-US")} emails sent, all time`}>{compact(analytics.sent)} sent</span> : null}
      </td>
      <td className="num">{os.markets === null ? <span className="ds-none">—</span> : os.markets.count || <span className="ds-none">0</span>}</td>
      <td onClick={stop}>
        {portalUrl ? (
          <a href={portalUrl} target="_blank" rel="noreferrer" className="ds-btn sm" title={portalUrl}>Open ↗</a>
        ) : <span className="ds-none" title="No portal yet">—</span>}
      </td>
    </tr>
  );
}

/* Rows a tool holds that are not on the roster, and deliberate non-clients. */
function ToolNotes({ data }: { data: ClientsOverview }) {
  const notes: React.ReactNode[] = [];
  for (const k of ["health", "inbox", "analytics"] as const) {
    const tool = data.tools[k];
    if (tool.unavailable) notes.push(<span key={k}><b>{tool.label}</b> could not be read — {tool.unavailable}. </span>);
    else if (tool.unknown.length) {
      notes.push(
        <span key={k}>
          <b>{tool.label}</b> holds {tool.unknown.length} entr{tool.unknown.length === 1 ? "y" : "ies"} not on the roster:{" "}
          {tool.unknown.join(", ")} — a client to add, or a spelling to record as an alias.{" "}
        </span>,
      );
    }
  }
  const exempt = [...new Map(Object.values(data.tools).flatMap((t) => t.exempt.map((e) => [e.name, e] as const))).values()];
  return notes.length || exempt.length ? (
    <p style={{ fontSize: 12.5, color: "var(--ds-muted)", margin: 0, lineHeight: 1.7 }}>
      {notes}
      {exempt.length ? <span><b>Kept on purpose, not clients:</b> {exempt.map((e) => `${e.name} (${e.reason})`).join(", ")}.</span> : null}
    </p>
  ) : null;
}

/*
 * The screen. `initial` is set only when the page was opened here — it then
 * server-renders with no loading state. Saves refresh the list in place
 * (the record panel stays open on the same client) instead of reloading the
 * whole page, which is what this used to do.
 */
export function ClientsScreen({ initial }: { initial: ClientsOverview | null }) {
  const [data, setData] = useState<ClientsOverview | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    invalidate(URL);
    try {
      setData(await loadOnce<ClientsOverview>(URL));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the client roster");
    }
  }, []);

  useEffect(() => { if (!initial) void refresh(); }, [initial, refresh]);

  if (!data) {
    return error ? (
      <div className="ds-page"><p className="ds-note"><b>The client roster could not be loaded.</b> {error}</p></div>
    ) : <PlaceholderScreen cards={5} />;
  }
  return <ClientsView data={data} onChanged={() => void refresh()} />;
}
