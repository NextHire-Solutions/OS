"use client";

import { useMemo, useState } from "react";

import type { OnboardingClient, OnboardingPipeline } from "@/lib/tools/onboarding/pipeline";
import { Lazy, PlaceholderScreen } from "../lazy";

/*
 * Onboarding — the pipeline.
 *
 * The orchestrator keeps running untouched: it receives the Typeform, Stripe,
 * EmailBison and Calendly webhooks and writes these rows. This reads them.
 *
 * The screen leads with what is STUCK rather than with totals. "37 clients in
 * onboarding" is true, unchanging and useless; "four have been at Copy sent
 * for a fortnight" is the thing somebody acts on. So the cards count
 * exceptions, and the default sort puts the longest-waiting first.
 */

/* The stage colours the orchestrator itself assigns, mapped to our palette. */
const STAGE_TONE: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: "var(--inset-2)", fg: "var(--ink-2)" },
  amber: { bg: "var(--yellow-bg)", fg: "var(--yellow)" },
  blue: { bg: "var(--blue-bg, #E8F0FF)", fg: "var(--blue, #0165FE)" },
  green: { bg: "var(--green-bg)", fg: "var(--green)" },
};

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

/** A client untouched for this long is worth a look. */
const STALE_DAYS = 14;

type Sort = "waiting" | "name" | "stage" | "created";

export function OnboardingPipelineScreen({ initial }: { initial: OnboardingPipeline | null }) {
  return (
    <Lazy<OnboardingPipeline>
      initial={initial}
      url="/api/tools/onboarding"
      label="Onboarding"
      skeleton={<PlaceholderScreen cards={5} />}
    >
      {(data) => <PipelineView data={data} />}
    </Lazy>
  );
}

function PipelineView({ data }: { data: OnboardingPipeline }) {
  // The SERVER's clock, not the browser's — see pipeline.ts.
  const now = new Date(data.now).getTime();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("waiting");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.clients.filter((c) => {
      if (stage !== "all" && (c.stageId ?? "none") !== stage) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.officeName ?? "").toLowerCase().includes(q) ||
        (c.primaryContact ?? "").toLowerCase().includes(q) ||
        (c.location ?? "").toLowerCase().includes(q)
      );
    });

    const waited = (c: OnboardingClient) => daysSince(c.updatedAt ?? c.createdAt, now) ?? -1;
    list = [...list].sort((a, b) => {
      switch (sort) {
        case "name": return a.name.localeCompare(b.name);
        case "stage": return (stageSort(data, a) - stageSort(data, b)) || a.name.localeCompare(b.name);
        case "created": return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        // Longest-waiting first — the whole point of the screen.
        default: return waited(b) - waited(a) || a.name.localeCompare(b.name);
      }
    });
    return list;
  }, [data, search, stage, sort, now]);

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
    <div className="wrap">
      <div className="cards" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
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
              tone={STAGE_TONE[s.color ?? "neutral"] ?? STAGE_TONE.neutral}
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
            <div className="tbl-sub">
              Longest-waiting first
              {rows.length !== all.length ? ` · showing ${rows.length} of ${all.length}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              placeholder="Search name, office, contact…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search onboarding clients"
            />
            <select
              className="inp"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort by"
              style={{ cursor: "pointer" }}
            >
              <option value="waiting">Longest waiting</option>
              <option value="stage">Stage</option>
              <option value="name">Name</option>
              <option value="created">Newest first</option>
            </select>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1240 }}>
            <thead>
              <tr>
                <th>Client</th>
                <th>Stage</th>
                <th>Waiting</th>
                <th>Plan</th>
                <th>Payment</th>
                <th>Campaign</th>
                <th>Leads</th>
                <th>Intros</th>
                <th>Portal</th>
                <th>On Roster</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    No clients match {search.trim() ? `“${search.trim()}”` : "this stage"}.
                  </td>
                </tr>
              ) : (
                rows.map((c) => <Row key={c.id} c={c} data={data} now={now} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ c, data, now }: { c: OnboardingClient; data: OnboardingPipeline; now: number }) {
  const waited = daysSince(c.updatedAt ?? c.createdAt, now);
  const done = c.stageName === "Live";
  const tone = STAGE_TONE[data.stages.find((s) => s.id === c.stageId)?.color ?? "neutral"] ?? STAGE_TONE.neutral;

  return (
    <tr>
      <td>
        <div className="cname">{c.name}</div>
        {c.officeName && c.officeName !== c.name ? <div className="csince">{c.officeName}</div> : null}
        {c.location ? <div className="csince">{c.location}</div> : null}
      </td>

      <td>
        {c.stageName ? (
          <span className="tg" style={{ background: tone.bg, borderColor: "transparent", color: tone.fg }}>
            {c.stageName}
          </span>
        ) : (
          <span
            className="tg"
            style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}
            title="This client is on no stage, so it appears on no board"
          >
            no stage
          </span>
        )}
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
        {c.leadsExported !== null ? (
          <span className="api-num tnum">{c.leadsExported.toLocaleString("en-US")}</span>
        ) : c.leadsInReview !== null ? (
          <span className="tnum mut" title="In review, not yet exported">
            {c.leadsInReview.toLocaleString("en-US")} in review
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
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

function stageSort(data: OnboardingPipeline, c: OnboardingClient): number {
  return data.stages.find((s) => s.id === c.stageId)?.sort ?? 999;
}
