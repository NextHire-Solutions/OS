"use client";

import { useMemo, useState } from "react";
import { STATUS_MEANING, STATUS_TONE, isClientStatus, statusLabel } from "@/lib/clients/client-status";
import { toneOf } from "@/lib/tools/onboarding/stage-types";

import type { OnboardingClient, OnboardingPipeline } from "@/lib/tools/onboarding/pipeline";
import { PlaceholderScreen } from "../lazy";
import { PIPELINE_URL, setClientStage, useOnboardingData } from "./actions";
import { Avatar } from "./photo-input";
import { RepliesPanel } from "./replies-panel";
import { Btn, Toast, useToast } from "./toast";

/*
 * Onboarding — the pipeline.
 *
 * The orchestrator keeps running untouched: it receives the Typeform, Stripe,
 * EmailBison and Calendly webhooks and writes these rows. This reads them.
 *
 * The screen leads with what is STUCK rather than with totals. "37 clients in
 * onboarding" is true, unchanging and useless; "four have been at Copy sent
 * for a fortnight" is the thing somebody acts on. So the cards count
 * exceptions.
 *
 * The table is the tool's `components/ClientTable.tsx`: its seven columns
 * first, in its order, then the columns only this workspace has. Every header
 * sorts on click and every column has a text filter, exactly as the tool's do.
 */

/*
 * Stage tints come from the one canonical map in stage-types.ts.
 *
 * This file used to carry its own four-entry copy, which silently lacked `red`
 * — the fifth colour the tool's stage editor offers. A stage coloured red drew
 * as neutral grey here while drawing red on the Stages editor and the client
 * ribbon. One map, one answer.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

/** A client untouched for this long is worth a look. */
const STALE_DAYS = 14;

/** Live status from the Health Dashboard, on our badge classes. Read-only — never written back. */
const HEALTH_CLASS: Record<string, string> = { active: "s-done", paused: "s-pending", churned: "s-risk" };

/**
 * One column: what it is called, and the string it sorts and filters on.
 *
 * Sorting is string-based, as the tool's is, so numbers are zero-padded in
 * `value` — otherwise 100 lands between 1 and 2. `text` is what the filter box
 * matches when the padded form would read strangely ("014" for "14d").
 */
type Col = {
  key: string;
  label: string;
  value: (c: OnboardingClient, now: number) => string;
  text?: (c: OnboardingClient, now: number) => string;
};

const pad = (n: number | null, width = 6) => String(n ?? -1).padStart(width, "0");

const COLS: Col[] = [
  // The tool's seven, in its order and with its labels.
  { key: "client_name", label: "Client", value: (c) => `${c.name} ${c.brand ?? ""}`.trim() },
  { key: "contact", label: "Contact", value: (c) => `${c.contactName ?? ""} ${c.contactEmail ?? ""}`.trim() },
  { key: "mls_location", label: "MLS / Location", value: (c) => `${c.mls ?? ""} ${c.location ?? ""}`.trim() },
  { key: "salesperson", label: "Salesperson", value: (c) => c.salespersonName ?? "" },
  // §8 Onboarding fields, read from the master record.
  { key: "account_manager", label: "Account Manager", value: (c) => c.accountManager ?? "" },
  { key: "sender", label: "Sender", value: (c) => c.sender ?? "" },
  // The client's lifecycle status from the master record (§11) — not the
  // Health Dashboard's copy, which a daily sync fills and which is blank for
  // every onboarding client.
  { key: "status", label: "Status", value: (c) => c.masterStatus ?? c.healthStatus ?? "" },
  { key: "team", label: "Team", value: (c) => pad(c.team), text: (c) => (c.team === null ? "" : String(c.team)) },
  { key: "agents", label: "Agents", value: (c) => pad(c.agents), text: (c) => (c.agents === null ? "" : String(c.agents)) },
  { key: "dnc", label: "DNC", value: (c) => pad(c.dnc), text: (c) => (c.dnc === null ? "" : String(c.dnc)) },
  { key: "stage", label: "Stage", value: (c) => c.stageName ?? "—" },
  { key: "progress", label: "Profile", value: (c) => String(c.progress.pct).padStart(3, "0"), text: (c) => `${c.progress.pct}%` },
  { key: "date_added", label: "Date added", value: (c) => c.createdAt ?? "" },
  // Ours.
  {
    key: "waiting",
    label: "Waiting",
    value: (c, now) => pad(daysSince(c.updatedAt ?? c.createdAt, now)),
    text: (c, now) => { const d = daysSince(c.updatedAt ?? c.createdAt, now); return d === null ? "" : `${d}d`; },
  },
  { key: "plan", label: "Plan", value: (c) => c.plan ?? "" },
  {
    key: "payment",
    label: "Payment",
    value: (c) => (c.paid ? `1 ${pad(c.amount, 9)}` : "0"),
    text: (c) => (c.paid ? (c.amount !== null ? `paid ${formatMoney(c.amount)}` : "paid") : "not yet"),
  },
  { key: "campaign", label: "Campaign", value: (c) => c.campaignStatus ?? "" },
  {
    key: "leads",
    label: "Leads",
    value: (c) => pad(c.leadsBuilt, 8),
    text: (c) => [c.leadsBuilt ? String(c.leadsBuilt) : "", c.inReview ? "in review" : "", c.exported ? "exported" : ""].filter(Boolean).join(" · "),
  },
  { key: "intros", label: "Intros", value: (c) => pad(c.intros), text: (c) => (c.intros > 0 ? String(c.intros) : "") },
  { key: "portal", label: "Portal", value: (c) => (c.portalUrl ? "open" : "") },
  { key: "roster", label: "On Roster", value: (c) => (c.rosterName ? "matched" : "unmatched") },
];

export function OnboardingPipelineScreen({ initial }: { initial: OnboardingPipeline | null }) {
  /*
   * `useOnboardingData` rather than `Lazy`, because this screen now WRITES: a
   * client can be moved along the board from the Stage column, and after a move
   * the data on screen is stale by definition. Same one-request cache, plus a
   * reload.
   */
  const { data, error, reload } = useOnboardingData<OnboardingPipeline>(initial, PIPELINE_URL);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Onboarding could not be loaded.</b> {error}
        </div>
      </div>
    );
  }
  if (!data) return <PlaceholderScreen cards={5} />;
  return <PipelineView data={data} reload={reload} />;
}

function PipelineView({ data, reload }: { data: OnboardingPipeline; reload: () => Promise<void> }) {
  // The SERVER's clock, not the browser's — see pipeline.ts.
  const now = new Date(data.now).getTime();
  const [stage, setStage] = useState<string>("all");
  // The tool's defaults: by client name, ascending; filters closed and empty.
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "client_name", dir: 1 });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const { toast, show } = useToast();
  const [moving, setMoving] = useState<string | null>(null);

  /* The manual move along the board — the tool's most-used write. */
  async function move(c: OnboardingClient, stageId: string) {
    setMoving(c.id);
    try {
      await setClientStage(c.id, stageId || null);
      await reload();
      const name = data.stages.find((s) => s.id === stageId)?.name ?? "no stage";
      show({ text: `${c.name} moved to ${name}` });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Could not move that client", bad: true });
    } finally {
      setMoving(null);
    }
  }

  const rows = useMemo(() => {
    // The stage board's click filter first, then the tool's per-column filters.
    const active = Object.entries(filters).filter(([, v]) => v.trim());
    let list = data.clients.filter((c) => {
      if (stage !== "all" && (c.stageId ?? "none") !== stage) return false;
      return active.every(([k, v]) => {
        const col = COLS.find((x) => x.key === k);
        return col ? (col.text ?? col.value)(c, now).toLowerCase().includes(v.trim().toLowerCase()) : true;
      });
    });

    const col = COLS.find((x) => x.key === sort.key);
    if (col) {
      list = [...list].sort(
        (a, b) => col.value(a, now).localeCompare(col.value(b, now), undefined, { sensitivity: "base" }) * sort.dir,
      );
    }
    return list;
  }, [data, filters, stage, sort, now]);

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const activeCount = Object.values(filters).filter((v) => v.trim()).length;

  const all = data.clients;
  const live = all.filter((c) => c.stageName === "Live").length;
  const stale = all.filter(
    (c) => c.stageName !== "Live" && (daysSince(c.updatedAt ?? c.createdAt, now) ?? 0) >= STALE_DAYS,
  ).length;
  const paidNotLaunched = all.filter((c) => c.paid && c.stageName !== "Live" && c.stageName !== "Launched").length;
  const launchedUnpaid = all.filter((c) => !c.paid && (c.stageName === "Live" || c.stageName === "Launched")).length;
  const offRoster = all.filter((c) => !c.rosterName).length;

  if (data.error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Onboarding could not be read.</b> {data.error}. The orchestrator itself is
          unaffected — this is the workspace&rsquo;s connection to its database.
        </div>
      </div>
    );
  }

  return (
    <div className="wrap onb-pipeline">
      {/*
         * Six cards in a five-column grid left "Off Roster" stranded alone on a
         * second row, which reads as a separate section rather than the last of
         * a set. `auto-fit` with a minimum lets the row hold all six on a wide
         * screen and fall to a balanced 3 + 3 when it cannot, instead of always
         * breaking 5 + 1.
         */}
        <div
          className="cards"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))" }}
        >
        <Card label="In Onboarding" value={all.length} sub="clients on the board" />
        <Card label="Live" value={live} sub="reached the final stage" tone="n-green" />
        <Card
          label={`Waiting ${STALE_DAYS}d+`}
          value={stale}
          sub="no change since"
          tone={stale > 0 ? "n-risk" : "n-green"}
        />
        <Card
          label="Paid, Not Live"
          value={paidNotLaunched}
          sub="money in, not launched"
          tone={paidNotLaunched > 0 ? "n-risk" : undefined}
        />
        <Card
          label="Live, Unpaid"
          value={launchedUnpaid}
          sub="launched without payment"
          tone={launchedUnpaid > 0 ? "n-risk" : undefined}
        />
        <Card
          label="Off Roster"
          value={offRoster}
          sub="no match on the 36"
          tone={offRoster > 0 ? "n-risk" : "n-green"}
        />
      </div>

      {/* The board, as counts per stage. Doubles as the stage filter. */}
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Stages</div>
            <div className="tbl-sub">Where each client sits. Click a stage to filter the table.</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "4px 22px 20px" }}>
          <StageChip
            label="All"
            count={all.length}
            on={stage === "all"}
            onClick={() => setStage("all")}
            tone={{ bg: "var(--inset-2)", fg: "var(--ink-2)" }}
          />
          {data.stages.map((s) => (
            <StageChip
              key={s.id}
              label={s.name}
              count={all.filter((c) => c.stageId === s.id).length}
              on={stage === s.id}
              onClick={() => setStage(s.id)}
              tone={toneOf(s.color)}
            />
          ))}
          {/* A client with no stage is invisible on a stage board — which is
              exactly the sort of client that gets forgotten. */}
          {all.some((c) => !c.stageId) ? (
            <StageChip
              label="No stage"
              count={all.filter((c) => !c.stageId).length}
              on={stage === "none"}
              onClick={() => setStage("none")}
              tone={{ bg: "var(--red-bg)", fg: "var(--red)" }}
            />
          ) : null}
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Clients</div>
            <div className="tbl-sub">Click a header to sort. Filter opens a box under every column.</div>
          </div>
          {/* The tool's toolbar: Filter / Clear, and how many of the rows are showing. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              {showFilters ? "Hide filters" : "Filter"}
              {activeCount ? ` (${activeCount})` : ""}
            </Btn>
            {activeCount > 0 && <Btn onClick={() => setFilters({})}>Clear</Btn>}
            <span className="tbl-sub tnum">
              {rows.length} of {all.length} clients
            </span>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1900 }}>
            <thead>
              <tr>
                {COLS.map((col) => {
                  const on = sort.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className="sortable"
                      onClick={() => toggleSort(col.key)}
                      title={`Sort by ${col.label}`}
                      aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                    >
                      {col.label}
                      <span className={`sort-ind${on ? " on" : ""}`}>{on ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</span>
                    </th>
                  );
                })}
              </tr>
              {showFilters && (
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
              )}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLS.length} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    {all.length === 0
                      ? "No clients yet — waiting on the first Typeform submission."
                      : activeCount > 0
                        ? "No clients match these filters."
                        : "No clients at this stage."}
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <Row key={c.id} c={c} data={data} now={now} onMove={move} moving={moving === c.id} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Where the tool puts it: under the table, hideable, remembered per browser. */}
      <RepliesPanel replies={data.replies} />

      <Toast toast={toast} />
    </div>
  );
}

function Row({
  c, data, now, onMove, moving,
}: {
  c: OnboardingClient;
  data: OnboardingPipeline;
  now: number;
  onMove: (c: OnboardingClient, stageId: string) => void;
  moving: boolean;
}) {
  const waited = daysSince(c.updatedAt ?? c.createdAt, now);
  const done = c.stageName === "Live";
  const tone = toneOf(data.stages.find((s) => s.id === c.stageId)?.color);

  return (
    <tr>
      <td>
        {/*
          The row's way into the client.

          This table used to dead-end: 38 clients you could move between stages
          and not one you could open. A plain <a> rather than a router push —
          /onboarding/clients/<id> resolves to this same destination id, so the
          shell keeps its place and the server builds the detail screen, exactly
          as /inbox/portals/<id> already works.

          Their photo when they have one, otherwise initials — as the tool's
          Avatar does. Brand below the name only when it says something new.
        */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar src={c.photoUrl} name={c.name} size={30} />
          <div>
            <a
              href={`/onboarding/clients/${c.id}`}
              className="cname"
              title={`Open ${c.name}`}
              style={{ textDecoration: "none", color: "var(--ink)" }}
            >
              {c.name}
            </a>
            {c.brand && c.brand !== c.name ? <div className="csince">{c.brand}</div> : null}
          </div>
        </div>
      </td>

      <td>
        {c.contactName ?? <span className="api-none">—</span>}
        {c.contactEmail ? <div className="cell-sub">{c.contactEmail}</div> : null}
      </td>

      <td>
        {c.mls ?? <span className="api-none">—</span>}
        {c.location ? <div className="cell-sub">{c.location}</div> : null}
      </td>

      <td>
        {c.salespersonName ? (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <Avatar src={c.salespersonPhoto} name={c.salespersonName} size={30} />
            {c.salespersonName}
          </span>
        ) : (
          <span className="badge s-neutral">unassigned</span>
        )}
      </td>

      <td>{c.accountManager ?? <span className="api-none" title="Not set on the client record">—</span>}</td>
      <td>{c.sender ?? <span className="api-none" title="Not set on the client record">—</span>}</td>

      <td>
        {/* The master record's status (§11) — the same badge every screen uses. */}
        {c.masterStatus && isClientStatus(c.masterStatus) ? (
          <span className={`badge ${STATUS_TONE[c.masterStatus]}`} title={STATUS_MEANING[c.masterStatus]}>
            <span className="dot" />
            {statusLabel(c.masterStatus)}
          </span>
        ) : c.healthStatus ? (
          <span className={`badge ${HEALTH_CLASS[c.healthStatus] ?? "s-neutral"}`} title="From the Health Dashboard — not linked to a master client">
            <span className="dot" />
            {c.healthStatus}
          </span>
        ) : (
          <span className="mut" title="Not linked to a master client">—</span>
        )}
      </td>

      <td className="tnum">{c.team === null ? <span className="api-none">—</span> : c.team}</td>
      <td className="tnum">{c.agents === null ? <span className="api-none">—</span> : c.agents.toLocaleString("en-US")}</td>
      <td className="tnum">{c.dnc === null ? <span className="api-none">—</span> : c.dnc.toLocaleString("en-US")}</td>

      <td>
        {/*
          The stage is a control, not a label. Moving a client along the board is
          the thing the team does most, and a pipeline that can only be read is
          a report rather than a pipeline.

          Tinted with the stage's own colour so the column still scans as a
          status at a glance, which the plain dropdown lost.
        */}
        <select
          className="inp"
          value={c.stageId ?? ""}
          disabled={moving}
          aria-label={`Stage for ${c.name}`}
          title={c.stageId ? `Move ${c.name} to another stage` : "This client is on no stage, so it appears on no board"}
          onChange={(e) => onMove(c, e.target.value)}
          style={{
            cursor: moving ? "progress" : "pointer",
            minWidth: 132,
            fontWeight: 600,
            background: c.stageId ? tone.bg : "var(--red-bg)",
            color: c.stageId ? tone.fg : "var(--red)",
            borderColor: "transparent",
            opacity: moving ? 0.5 : 1,
          }}
        >
          <option value="">no stage</option>
          {data.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </td>

      <td>
        <ProgressCell progress={c.progress} />
      </td>

      {/* A fixed locale and zone: this cell is server-rendered, and the browser's
          own locale (14/09/2026 vs 9/14/2026) failed hydration. */}
      <td className="tnum mut">
        {c.createdAt
          ? new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
          : <span className="api-none">—</span>}
      </td>

      <td>
        {waited === null ? (
          <span className="api-none">—</span>
        ) : done ? (
          <span className="tnum mut">{waited}d</span>
        ) : waited >= STALE_DAYS ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {waited}d
          </span>
        ) : (
          <span className="tnum mut">{waited}d</span>
        )}
      </td>

      <td>
        {c.plan ? (
          <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
            {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>

      <td>
        {c.paid ? (
          <span className="badge s-done">
            <span className="dot" />
            {c.amount !== null ? formatMoney(c.amount) : "Paid"}
          </span>
        ) : (
          <span className="api-none">not yet</span>
        )}
      </td>

      <td>
        {c.campaignStatus ? (
          <span className={`badge ${c.campaignStatus === "active" ? "s-done" : "s-pending"}`}>
            <span className="dot" />
            {c.campaignStatus.charAt(0).toUpperCase() + c.campaignStatus.slice(1)}
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>

      <td>
        {/* The agents built for this client, and the two yes/no flags. The old
            cell read those flags as numbers and so could never show anything. */}
        {c.leadsBuilt > 0 ? <span className="api-num tnum">{c.leadsBuilt.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}
        {c.inReview || c.exported ? (
          <div className="cell-sub">{[c.inReview ? "in review" : null, c.exported ? "exported" : null].filter(Boolean).join(" · ")}</div>
        ) : null}
      </td>

      <td>{c.intros > 0 ? <span className="api-num tnum">{c.intros}</span> : <span className="api-none">—</span>}</td>

      <td>
        {c.portalUrl ? (
          <a href={c.portalUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", fontWeight: 700 }}>
            open
          </a>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>

      <td>
        {c.rosterName ? (
          <span className="mut" title={`Matches “${c.rosterName}” on the roster`}>✓</span>
        ) : (
          <span
            className="tg"
            style={{ background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }}
            title="No match on the canonical roster — either a new client or a spelling to add as an alias"
          >
            unmatched
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Profile completed — the share of onboarding steps that have run for this
 * client. It counts ticks, so it moves only when someone actually runs a step.
 */
function ProgressCell({ progress }: { progress: OnboardingClient["progress"] }) {
  const pct = progress.pct;
  const tone = pct === 100 ? "green" : pct >= 50 ? "amber" : "red";
  return (
    <div className="progress" title={`${progress.done} of ${progress.total} steps done`}>
      <div className="progress-track">
        <span className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-pct">{pct}%</span>
    </div>
  );
}

function StageChip({
  label, count, on, onClick, tone,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
  tone: { bg: string; fg: string };
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={`${count} ${count === 1 ? "client" : "clients"} at ${label}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 14px",
        borderRadius: 11,
        border: on ? "1px solid var(--ink-2)" : "1px solid var(--line-soft)",
        background: on ? tone.bg : "var(--surface)",
        color: on ? tone.fg : "var(--ink)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: on ? 700 : 600,
      }}
    >
      {label}
      <span
        className="tnum"
        style={{
          background: on ? "transparent" : tone.bg,
          color: tone.fg,
          borderRadius: 7,
          padding: "1px 7px",
          fontWeight: 700,
        }}
      >
        {count}
      </span>
    </button>
  );
}

/** Whole days since an ISO timestamp, or null when there is none. */
function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function formatMoney(amount: number): string {
  // Stripe reports minor units; anything under 1000 is already dollars.
  const dollars = amount >= 1000 ? amount / 100 : amount;
  return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
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
