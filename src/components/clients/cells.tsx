"use client";

import { StatusPill } from "@/components/ds";
import type { MasterClient } from "@/lib/clients/master-list";
import { TIME_ZONES } from "@/lib/tools/client-health/types";
import { splitManagers } from "@/lib/identity/team-match";

/*
 * How every field of the master client record reads — ONE renderer for the
 * table, the six tool views and the record panel, so a date, a person or an
 * empty value looks the same wherever it appears (§13: no "different
 * terminology for the same piece of information").
 *
 * Empty is an em dash, never a zero and never a blank: "—" says "not
 * recorded", which is the truth, where "0" would be a claim.
 */

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DAY_ET = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/** "Sep 16, 2026". A bare date reads in UTC (it IS a calendar day); a moment in Eastern. */
export function fmtDay(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return null;
  return (/^\d{4}-\d{2}-\d{2}$/.test(v) ? DAY : DAY_ET).format(d);
}

export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? null : n.toLocaleString("en-US"));
export const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n.toLocaleString("en-US");

export const PLAN_LABEL: Record<string, string> = { minimum: "Minimum", production: "Production", partner: "Partner" };
export const planLabel = (p: string | null) => (p ? PLAN_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1) : null);

export const INTERVAL_LABEL: Record<string, string> = {
  biweekly: "Every 14 days", "28-days": "Every 28 days", monthly: "Monthly", custom: "Custom",
};
export function intervalLabel(v: string | null, days?: number | null): string | null {
  if (!v) return null;
  if (v === "custom") return days ? `Every ${days} days` : "Custom";
  return INTERVAL_LABEL[v] ?? v;
}

const TZ_LABEL: Record<string, string> = Object.fromEntries(TIME_ZONES.map((t) => [t.value, t.label]));
export const tzLabel = (v: string | null) => (v ? TZ_LABEL[v] ?? v : null);

/* ------------------------------------------------------------ primitives --- */

export function None({ title }: { title?: string }) {
  return <span className="cx-none" title={title ?? "Not recorded"}>—</span>;
}

/** A person: initials in a tinted square, then the name. */
export function Person({ name }: { name: string | null }) {
  if (!name) return <None />;
  return (
    <span className="cx-person">
      <span className="cx-av sm" style={avatarStyle(name)} aria-hidden="true">{initials(name)}</span>
      {name}
    </span>
  );
}

export function initials(name: string): string {
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : w[0]?.[1] ?? "")).toUpperCase();
}

const HUES = [214, 262, 190, 152, 28, 340, 232, 170, 12, 290];
export function avatarStyle(name: string): React.CSSProperties {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return { background: `hsl(${hue} 85% 95%)`, color: `hsl(${hue} 55% 36%)`, boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 88%)` };
}

/** An id in mono, shortened in the middle, copied on click. */
export function Id({ value }: { value: string | null }) {
  if (!value) return <None />;
  const short = value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
  return (
    <button type="button" className="cx-id" title={`${value} — click to copy`}
      onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(value); }}>
      {short}
    </button>
  );
}

export function PlanTag({ plan }: { plan: string | null }) {
  if (!plan) return <None />;
  return <span className={`cx-plan p-${plan}`}>{planLabel(plan)}</span>;
}

export function Meter({ value, max, tone }: { value: number; max: number; tone?: "green" | "amber" | "red" | "brand" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <span className={`cx-meter t-${tone ?? "brand"}`} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>;
}

const PACE: Record<string, { label: string; tone: "green" | "amber" | "red" }> = {
  done: { label: "Done", tone: "green" }, ok: { label: "On Track", tone: "amber" }, risk: { label: "At Risk", tone: "red" },
};

/* --------------------------------------------------------------- the cell --- */

/**
 * The value of one field (a key from field-registry.ts, or one of the extra
 * keys a §8 tool view uses) for one client.
 */
export function Cell({ k, c }: { k: string; c: MasterClient }) {
  switch (k) {
    case "clientId": return <Id value={c.id} />;
    case "name": return <b className="cx-strong">{c.name}</b>;
    case "status": return <StatusPill status={c.status} size="sm" />;
    case "plan": return <PlanTag plan={c.plan} />;
    case "startDate": case "onboardingDate": case "dateAdded": case "firstBillingDate": case "billingAnchorDate":
    case "nextBillingDate": case "pauseDate": case "churnDate": case "reactivationDate": {
      const v = fmtDay(c[k]);
      return v ? <span className="cx-date">{v}</span> : <None />;
    }
    // As the client data sheet has them (0022): Markets a number, MLS and Area lists.
    case "market": {
      if (c.markets === null) return <None title="Markets could not be read" />;
      return c.markets.markets === null ? <None title="None recorded yet" /> : <span className="cx-num">{c.markets.markets}</span>;
    }
    case "mls": case "area": {
      if (c.markets === null) return <None title="Markets could not be read" />;
      const vals = k === "mls" ? c.markets.mls : c.markets.areas;
      if (!vals.length) return <None title="None recorded yet" />;
      return <span title={vals.join(", ")}>{vals[0]}{vals.length > 1 ? <span className="cx-more">+{vals.length - 1}</span> : null}</span>;
    }
    case "timezone": return c.timezone ? <span title={c.timezone}>{tzLabel(c.timezone)}</span> : <None />;
    case "team": case "agents": case "dnc": {
      const v = c[k];
      return v === null ? <None title="Master Inbox could not be read" /> : <span className="cx-num">{fmtNum(v)}</span>;
    }
    case "accountManager": {
      // One or more, in order (30 Sep): "Amy, Eddy".
      const names = splitManagers(c.accountManager);
      if (names.length <= 1) return <Person name={names[0] ?? null} />;
      return <span className="cx-people">{names.map((n) => <Person key={n} name={n} />)}</span>;
    }
    case "sender": case "salesperson": case "campaignSender":
      return <Person name={k === "campaignSender" ? c.sender : c[k]} />;
    case "billingInterval": return c.billingInterval ? <span>{intervalLabel(c.billingInterval, c.billingIntervalDays)}</span> : <None />;
    case "stripeCustomerId": case "stripeSubscriptionId": return <Id value={c[k]} />;
    case "campaigns": {
      const n = c.campaigns?.length ?? c.analytics.campaigns;
      return n === null || n === undefined ? <None /> : <span className="cx-num">{fmtNum(n)}</span>;
    }
    case "campaignName": {
      if (!c.campaigns) return <None />;
      if (!c.campaigns.length) return <None title="No campaign linked" />;
      return (
        <span className="cx-clip" title={c.campaigns.map((x) => x.name).join("\n")}>
          {c.campaigns[0].name}{c.campaigns.length > 1 ? <span className="cx-more">+{c.campaigns.length - 1}</span> : null}
        </span>
      );
    }
    case "campaignId": {
      if (!c.campaigns?.length) return <None />;
      return <span className="cx-inline"><Id value={c.campaigns[0].id} />{c.campaigns.length > 1 ? <span className="cx-more">+{c.campaigns.length - 1}</span> : null}</span>;
    }
    case "campaignStatus": {
      if (!c.campaigns?.length) return <None />;
      const count = (s: string) => c.campaigns!.filter((x) => (x.status ?? "").toLowerCase() === s).length;
      const run = count("running"), paused = count("paused"), fin = count("finished");
      return (
        <span className="cx-inline">
          {run ? <span className="cx-chip t-green">{run} running</span> : null}
          {paused ? <span className="cx-chip t-orange">{paused} paused</span> : null}
          {fin ? <span className="cx-chip">{fin} finished</span> : null}
          {!run && !paused && !fin ? <None title="Status not reported by the platform" /> : null}
        </span>
      );
    }
    case "campaignAliases": return c.campaignAliases.length
      ? <span className="cx-clip" title={c.campaignAliases.join(", ")}>{c.campaignAliases.join(", ")}</span> : <None />;
    case "campaignLocation": return c.campaignLocation ? <span>{c.campaignLocation}</span> : <None title="Not recorded in the Database" />;
    case "assignedLeads": case "introductions": case "replies": case "bounces": case "sequencers":
    case "weeklyTarget": case "monthlyTarget": {
      const v = c[k];
      return v === null ? <None /> : <span className="cx-num">{fmtNum(v)}</span>;
    }
    case "inReview": case "exported": {
      const v = c[k];
      if (v === null) return <None />;
      if (typeof v === "boolean") return <span className={`cx-chip${v ? " t-green" : ""}`}>{v ? "Yes" : "No"}</span>;
      return <span className="cx-num">{fmtNum(v)}</span>;
    }
    /* ---- the extra columns a §8 tool view uses ---- */
    case "performance": {
      const p = c.health.period;
      if (!p) return <None title="No monthly target set" />;
      const tone = c.health.pace === "done" ? "green" : c.health.pace === "ok" ? "amber" : "red";
      return (
        <span className="cx-perf" title="Introductions this 28-day period / the monthly target">
          <span className="cx-num"><b>{p.delivered}</b>/{p.target}</span>
          <Meter value={p.delivered} max={p.target} tone={tone} />
        </span>
      );
    }
    case "health": {
      if (!c.health.pace || c.health.pace === "pending") return <None title="No billing schedule or target" />;
      const pace = PACE[c.health.pace];
      const carry = c.health.cycle?.carryIn ?? 0;
      return (
        <span className="cx-inline">
          <span className={`cx-chip t-${pace.tone === "amber" ? "orange" : pace.tone}`}>{pace.label}</span>
          {carry > 0 ? <span className="cx-chip t-red" title="Introductions carried forward from the last cycle">+{carry} carried</span> : null}
        </span>
      );
    }
    case "onboardingStatus": case "onboardingProgress": {
      const pr = c.onboarding.progress;
      if (!c.onboarding.present) return <None title="Not in Onboarding" />;
      return (
        <span className="cx-perf" title={c.onboarding.stage ?? undefined}>
          {k === "onboardingStatus" && c.onboarding.stage ? <span>{c.onboarding.stage}</span> : null}
          {pr ? <><span className="cx-num">{pr.done}/{pr.total}</span><Meter value={pr.done} max={pr.total} tone={pr.pct >= 100 ? "green" : "brand"} /></> : null}
        </span>
      );
    }
    case "portal": {
      if (!c.portal.count) return <None title="No portal" />;
      const links = c.portal.links ?? [];
      return (
        <span className="cx-inline">
          {links.length > 1
            ? links.map((l) => l.enabled
                ? <a key={l.url} className="cx-link" href={l.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{portalShortName(l.name, links)} ↗</a>
                : <span key={l.url} className="cx-chip" title={l.name}>{portalShortName(l.name, links)} closed</span>)
            : c.portal.url
              ? <a className="cx-link" href={c.portal.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open portal ↗</a>
              : <span className="cx-chip">Portal closed</span>}
          <span className="cx-sub">{fmtNum(c.introductions)} introductions</span>
        </span>
      );
    }
    case "campaignMetrics": {
      const sent = c.analytics.sent;
      if (sent === null) return <None />;
      const rate = sent > 0 && c.replies !== null ? (c.replies / sent) * 100 : null;
      return (
        <span className="cx-inline">
          <span className="cx-num">{compact(sent)} sent</span>
          {rate !== null ? <span className="cx-sub">{rate.toFixed(1)}% reply</span> : null}
          {c.bounces !== null && sent > 0 ? <span className="cx-sub">{((c.bounces / sent) * 100).toFixed(1)}% bounce</span> : null}
        </span>
      );
    }
    default: return <None />;
  }
}

/** A plain-text value for CSV export and search — the same meaning as the cell. */
export function textOf(k: string, c: MasterClient): string {
  switch (k) {
    case "clientId": return c.id;
    case "status": return c.status.charAt(0).toUpperCase() + c.status.slice(1);
    case "plan": return planLabel(c.plan) ?? "";
    case "market": return c.markets?.markets == null ? "" : String(c.markets.markets);
    case "mls": return (c.markets?.mls ?? []).join("; ");
    case "area": return (c.markets?.areas ?? []).join("; ");
    case "timezone": return tzLabel(c.timezone) ?? "";
    case "billingInterval": return intervalLabel(c.billingInterval, c.billingIntervalDays) ?? "";
    case "campaignId": return (c.campaigns ?? []).map((x) => x.id).join("; ");
    case "campaignName": return (c.campaigns ?? []).map((x) => x.name).join("; ");
    case "campaignStatus": return (c.campaigns ?? []).map((x) => `${x.name}: ${x.status ?? "?"}`).join("; ");
    case "campaignAliases": return c.campaignAliases.join("; ");
    case "campaignSender": return c.sender ?? "";
    default: {
      const v = (c as unknown as Record<string, unknown>)[k];
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? "Yes" : "No";
      return String(v);
    }
  }
}

/** "Properties & Estates Florida" among its siblings → "Florida": the market is what tells them apart. */
export function portalShortName(name: string, all: { name: string }[]): string {
  const words = all.map((x) => x.name.split(/\s+/));
  let common = 0;
  while (words.length > 1 && words.every((w) => w.length > common && w[common] === words[0][common])) common++;
  return name.split(/\s+/).slice(common).join(" ") || name;
}

/**
 * What the Introduce button needs and this client lacks — the "intro template"
 * (contact name and role on the record). Empty when it can introduce.
 */
export function introMissing(c: { status: string; contact: { name: string | null; role: string | null } }): string[] {
  // Only clients we introduce to now; paused and churned are not flagged.
  if (c.status !== "active" && c.status !== "onboarding") return [];
  const out: string[] = [];
  if (!c.contact.name?.trim()) out.push("contact name");
  if (!c.contact.role?.trim()) out.push("role");
  return out;
}
