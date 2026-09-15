"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  filtersToSearchParams,
  resolveFilters,
  toISODate,
  type ResolvedFilters,
} from "@/lib/tools/analytics/query-params.ts";
import { rangeLabel } from "@/lib/tools/analytics/format.ts";
import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { loadOnce } from "../lazy";
import { REPLY_FACETS_URL, useAnalyticsData } from "./actions";

/*
 * Analytics' filter state, and the one place this port deviates from the tool.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT useSearchParams + router.push
 *
 * The tool keeps every filter in the URL and changes it with `router.push`, so
 * each deliberate click is a history entry and a pasted link reopens the same
 * view. That is right for a standalone app, and it cannot be copied here.
 *
 * The workspace shell renders ONE screen per server request
 * (`app/[[...slug]]/page.tsx` builds only the active one) and navigates warm
 * panes with `history.pushState` precisely so a screen is not torn down. A
 * `router.push` from inside a screen asks Next for a fresh RSC payload for
 * `/analytics/campaign`, which REMOUNTS this screen — losing the open
 * accordion, the scroll position and the sub-view, on every filter click.
 *
 * So the state lives in React and the URL is kept in step with
 * `history.replaceState`. What survives:
 *
 *   · a pasted link still opens the view it names (read once, on mount)
 *   · the query string handed to every API route is `filtersToSearchParams`,
 *     the tool's own serialiser, so client and server cannot disagree about
 *     what "7d" means — CLAUDE.md rule 4 is intact, which is the load-bearing
 *     half
 *
 * What is lost: Back no longer steps through filter changes. That is a real
 * cost and it is recorded in ANALYTICS-PARITY.md rather than hidden — the
 * alternative was a screen that reset itself every time you touched a chip.
 *
 * `today` is resolved ONCE, on the server side of the first render, and passed
 * down — never read from the clock during a render. Same rule as
 * `lib/workspace/dates.ts`: an unpinned clock has caused a hydration bug in
 * this repo three times.
 */

interface FilterContextValue {
  filters: ResolvedFilters;
  today: string;
  setFilters: (patch: Partial<ResolvedFilters>) => void;
  toQueryString: () => string;
}

const Ctx = createContext<FilterContextValue | null>(null);

/**
 * Seeds from the address bar exactly once.
 *
 * Not from a prop, because the shell mounts this screen without passing the
 * query string, and not on every render, because that would fight `setFilters`.
 */
function seed(today: string): ResolvedFilters {
  const search = typeof window === "undefined" ? "" : window.location.search;
  try {
    return resolveFilters(new URLSearchParams(search), today);
  } catch {
    // A hand-edited or stale URL must not blank the page — the tool's rule.
    return resolveFilters(new URLSearchParams(), today);
  }
}

export function AnalyticsFilters({
  today,
  children,
}: {
  today: string;
  children: React.ReactNode;
}) {
  /*
   * The server renders with NO query string and the browser then seeds from the
   * address bar, so the first client render must match the server's or React
   * throws #418. `mounted` gates the seed into an effect: the first paint is
   * always the default window, and a link carrying filters resolves them one
   * tick later.
   */
  const [filters, setState] = useState<ResolvedFilters>(() =>
    resolveFilters(new URLSearchParams(), today),
  );
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const fromUrl = seed(today);
    if (filtersToSearchParams(fromUrl).toString() !== filtersToSearchParams(filters).toString()) {
      setState(fromUrl);
    }
    // Deliberately runs once. `filters` is read, not depended on: re-running
    // this on every filter change would re-seed from a URL we just wrote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const setFilters = useCallback((patch: Partial<ResolvedFilters>) => {
    setState((current) => {
      const next = resolveFilters(
        filtersToSearchParams({ ...current, ...patch }),
        today,
      );
      if (typeof window !== "undefined") {
        const qs = filtersToSearchParams(next).toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${qs ? `?${qs}` : ""}`,
        );
      }
      return next;
    });
  }, [today]);

  const value = useMemo<FilterContextValue>(
    () => ({
      filters,
      today,
      setFilters,
      toQueryString: () => filtersToSearchParams(filters).toString(),
    }),
    [filters, today, setFilters],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnalyticsFilters(): FilterContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAnalyticsFilters must be used inside <AnalyticsFilters>");
  return value;
}

/** Today in the business's timezone, resolved once per mount, never per render. */
export function todayInET(): string {
  return toISODate(new Date());
}

/* ========================================================================== */
/*                              THE FILTER BAR                                */
/* ========================================================================== */

export interface FilterOption {
  value: string;
  label: string;
  hint?: string;
}

interface FilterOptions {
  campaigns: FilterOption[];
  clients: FilterOption[];
}

const FILTERS_URL = "/api/tools/analytics/filters";

/**
 * Which tab is on screen decides which controls appear.
 *
 * The tool hides three of them, each with a written post-mortem: Compare (only
 * the Campaign tab draws deltas), Platform (was gated to Attribution long after
 * the routes started honouring it — "a working filter with no way to reach it
 * is the same as a missing feature"), and Campaigns on Volume ("selecting a
 * campaign left the total at 251,963 and every bar unchanged … it is worse here
 * because the tab still LOOKS filtered").
 */
export type FilterTab = "campaign" | "volume" | "infrastructure" | "attribution" | "copy";

/*
 * Labels match `reply_dimensions` exactly, and that is not cosmetic.
 *
 * The tool's bar said "Brokerage" for `company` while the breakdown cards on
 * the same screen show BOTH "Brokerage (client)" (the client the campaign
 * belongs to) and "Current brokerage" (`company` — where the person works
 * today). So the filter named after one card actually filtered the other.
 *
 * Only these three of the six dimensions are filterable from the bar; the rest
 * are reachable by clicking a row on their breakdown card, which drills the
 * reply list by that value.
 */
const REPLY_FACETS = [
  { key: "company", label: "Current brokerage" },
  { key: "location", label: "Location" },
  { key: "sales_volume", label: "Sales volume" },
] as const;

/**
 * Reply attribute filters (REQ page 2) — the tool's `ReplyFacetFilters`.
 *
 * They describe the PERSON who replied, so they are shown only on the Replies
 * sub-view: on Charts or Campaigns, where a row is a day or a campaign, they
 * would be controls that silently do nothing. Their values come from the data
 * for the current range, capped at the 50 most common per dimension.
 *
 * The route serialises them as `reply_company`, `reply_location` and
 * `reply_sales_volume` — one param per value, never comma-joined, because a
 * brokerage name may contain a comma. That is `filtersToSearchParams`' job;
 * this component only writes `filters.replyFacets`.
 */
function ReplyFacetFilters() {
  const { filters, setFilters } = useAnalyticsFilters();
  const qs = useMemo(
    () => new URLSearchParams({ from: filters.from, to: filters.to, preset: "custom" }).toString(),
    [filters.from, filters.to],
  );
  const { data } = useAnalyticsData<{
    facets: Record<string, Array<{ value: string; label: string; count: number }>>;
  }>(REPLY_FACETS_URL(qs));

  return (
    <>
      {REPLY_FACETS.map(({ key, label }) => (
        <MultiSelect
          key={key}
          label={label}
          options={(data?.facets?.[key] ?? []).map((o) => ({
            value: o.value,
            label: o.label,
            hint: o.count.toLocaleString("en-US"),
          }))}
          selected={filters.replyFacets[key] ?? []}
          onChange={(values) =>
            setFilters({ replyFacets: { ...filters.replyFacets, [key]: values } })
          }
        />
      ))}
    </>
  );
}

export function FilterBar({
  tab,
  showReplyFacets,
}: {
  tab: FilterTab;
  /**
   * The Campaign screen's Replies sub-view is local state there, not a URL
   * param as in the tool (`filters.view === "replies"`), so the screen says
   * when the reply-attribute filters apply.
   */
  showReplyFacets?: boolean;
}) {
  const { filters, setFilters } = useAnalyticsFilters();
  const [options, setOptions] = useState<FilterOptions | null>(null);

  useEffect(() => {
    let live = true;
    loadOnce<FilterOptions>(FILTERS_URL).then(
      (o) => { if (live) setOptions(o); },
      () => {},
    );
    return () => { live = false; };
  }, []);

  // Infrastructure is lifetime figures only; the tool hides the whole bar.
  // Hooks run first — an early return above them would change the hook order
  // between tabs, which is the tool's own note on this line.
  if (tab === "infrastructure") return null;

  const supportsCompare = tab === "campaign";
  const supportsPlatform = tab === "attribution" || tab === "campaign" || tab === "volume";
  const supportsCampaignFilter = tab !== "volume";

  return (
    <div className="an-filter">
      <div className="qr" role="group" aria-label="Date range">
        {(["7d", "30d", "90d"] as const).map((preset) => (
          <button
            key={preset}
            type="button"
            className={filters.preset === preset ? "on" : ""}
            aria-pressed={filters.preset === preset}
            // Clearing from/to as well: a stale custom range left behind would
            // win over the preset and the pill would look ignored.
            onClick={() => setFilters({ preset, from: undefined, to: undefined })}
          >
            {preset}
          </button>
        ))}
      </div>

      <RangePicker />

      <span className="sep" aria-hidden />

      {supportsCampaignFilter ? (
        <MultiSelect
          label="Campaigns"
          options={options?.campaigns ?? []}
          selected={filters.campaignIds}
          onChange={(campaignIds) => setFilters({ campaignIds })}
        />
      ) : null}

      <MultiSelect
        label="Clients"
        options={options?.clients ?? []}
        selected={filters.clientIds}
        onChange={(clientIds) => setFilters({ clientIds })}
      />

      {supportsPlatform ? (
        <MultiSelect
          label="Platform"
          options={[
            { value: "emailbison", label: "EmailBison" },
            { value: "instantly", label: "Instantly" },
          ]}
          selected={filters.platforms}
          onChange={(platforms) =>
            setFilters({ platforms: platforms as ResolvedFilters["platforms"] })
          }
        />
      ) : null}

      {showReplyFacets ? <ReplyFacetFilters /> : null}

      {supportsCompare ? (
        <label
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            fontSize: 13, color: "var(--ink-2)", whiteSpace: "nowrap", cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={filters.compare}
            onChange={(e) => setFilters({ compare: e.target.checked })}
            style={{ accentColor: "var(--blue)", cursor: "pointer" }}
          />
          Compare previous
          {filters.compare && filters.compareFrom && filters.compareTo ? (
            <span className="mut">vs {rangeLabel(filters.compareFrom, filters.compareTo)}</span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}

/**
 * The custom range, committed on Apply.
 *
 * The tool's rule, kept: nothing refetches while you are typing. Two dates that
 * arrive inverted are swapped by `resolveFilters`, so a backwards range is a
 * working range rather than an empty screen.
 */
function RangePicker() {
  const { filters, setFilters } = useAnalyticsFilters();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span style={{ position: "relative", flex: "none" }}>
      <button
        ref={triggerRef}
        type="button"
        className="gh"
        aria-expanded={open}
        onClick={() => {
          // Seeded in the handler, not an effect — the React Compiler lint
          // rejects setState inside an effect, and this is the tool's own
          // workaround from range-picker.tsx.
          if (!open) { setFrom(filters.from); setTo(filters.to); }
          setOpen((v) => !v);
        }}
      >
        {rangeLabel(filters.from, filters.to)}
      </button>
      {/*
        Portalled, not absolutely positioned: `.an-filter` is `overflow-x:auto`,
        which the spec turns into `overflow-y:auto` as well, and this panel was
        being clipped to the height of the bar. See ui/anchored-panel.tsx.
      */}
      <AnchoredPanel anchorRef={triggerRef} open={open} onClose={close} label="Custom date range">
        <div style={{ padding: 14, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "block" }}>
            <span className="as-l">From</span>
            <input className="inp" type="date" value={from} max={to}
              style={{ minWidth: 150 }}
              onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label style={{ display: "block" }}>
            <span className="as-l">To</span>
            <input className="inp" type="date" value={to} min={from}
              style={{ minWidth: 150 }}
              onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-pri"
            onClick={() => {
              setFilters({ preset: "custom", from, to });
              setOpen(false);
            }}
          >
            Apply
          </button>
          <button type="button" className="btn" onClick={close}>Cancel</button>
        </div>
      </AnchoredPanel>
    </span>
  );
}

/**
 * A multi-select over a long list.
 *
 * The tool uses a Radix popover with cmdk inside. This is the same behaviour in
 * the workspace's own controls: a `.gh` trigger, a searchable panel, and chips
 * for what is selected. Two chips then "+N more", and clicking the overflow
 * clears the selection — the tool's `title="Clear all"`.
 */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const chosen = useMemo(
    () => options.filter((o) => selected.includes(o.value)),
    [options, selected],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;
    // 200 rows is already more than anyone scrolls; the search is the way in.
    return matched.slice(0, 200);
  }, [options, q]);

  return (
    <span style={{ position: "relative", flex: "none" }}>
      <button
        ref={triggerRef}
        type="button"
        className="gh"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={selected.length ? { borderColor: "var(--blue)", color: "var(--blue-ink)" } : undefined}
      >
        {label}
        {selected.length ? <span className="cpill">{selected.length}</span> : null}
      </button>

      {selected.length ? (
        <span className="chips" style={{ display: "inline-flex", marginLeft: 7, verticalAlign: "middle" }}>
          {chosen.slice(0, 2).map((o) => (
            <button
              key={o.value}
              type="button"
              className="c c-camp"
              title={`Remove ${o.label}`}
              style={{ cursor: "pointer", maxWidth: "11rem" }}
              onClick={() => onChange(selected.filter((v) => v !== o.value))}
            >
              {o.label} ×
            </button>
          ))}
          {selected.length > 2 ? (
            <button
              type="button"
              className="c c-camp"
              title="Clear all"
              style={{ cursor: "pointer" }}
              onClick={() => onChange([])}
            >
              +{selected.length - 2} more
            </button>
          ) : null}
        </span>
      ) : null}

      {/*
        Portalled for the same reason as the range picker — the filter bar's
        `overflow-x:auto` clips vertically too. See ui/anchored-panel.tsx.
      */}
      <AnchoredPanel anchorRef={triggerRef} open={open} onClose={close} width={330} label={label}>
          <div style={{ padding: 10, borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
            <input
              className="inp"
              autoFocus
              placeholder={`Search ${label.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: "100%", minWidth: 0 }}
            />
          </div>
          {/*
            `flex:1` with `minHeight:0` rather than a fixed 300px cap: the panel
            now knows how much room it actually has (AnchoredPanel measures it),
            so a short viewport scrolls the list instead of overflowing offscreen.
          */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {shown.length === 0 ? (
              <div style={{ padding: "20px 14px", color: "var(--muted)", fontSize: 13 }}>
                {options.length === 0 ? "Loading…" : "Nothing matches."}
              </div>
            ) : (
              shown.map((o) => {
                const on = selected.includes(o.value);
                return (
                  <label
                    key={o.value}
                    style={{
                      display: "flex", alignItems: "center", gap: 9, padding: "8px 13px",
                      fontSize: 13, cursor: "pointer", color: "var(--ink-2)",
                      background: on ? "var(--blue-pale)" : undefined,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                      onChange={() =>
                        onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                      }
                    />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.label}
                    </span>
                    {o.hint ? <span className="mut tnum" style={{ fontSize: 11.5 }}>{o.hint}</span> : null}
                  </label>
                );
              })
            )}
          </div>
          <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--line-soft)", flex: "none" }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onChange([])}>
              Clear
            </button>
            <button type="button" className="btn btn-pri" style={{ flex: 1 }} onClick={close}>
              Done
            </button>
          </div>
      </AnchoredPanel>
    </span>
  );
}
