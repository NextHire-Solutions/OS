"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { DASH, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import {
  DOMAIN_COLUMNS,
  domainRows,
  domainSortValue,
  positiveRate,
  type DomainRow,
} from "@/lib/tools/analytics/inbox-domains.ts";
import {
  FACET_LABEL,
  INBOX_COLUMNS,
  INBOX_COLUMNS_ADDED,
  INBOX_COLUMN_GROUPS,
  INBOX_COLUMN_PREFS_KEY,
  INBOX_COLUMN_PREFS_VERSION,
  INBOX_DEFAULT_VISIBLE,
  INBOX_FACETS,
  NO_FILTERS,
  PLATFORM_LABEL,
  facetChipLabel,
  facetOptions,
  filterInboxes,
  filtersActive,
  inboxSortValue,
  statusTone,
  toggleValue,
  type FacetOption,
  type InboxFacet,
  type InboxFilters,
  type InboxPlatform,
  type InboxRow,
  type InboxesResponse,
} from "@/lib/tools/analytics/inboxes.ts";
import {
  NO_RANGES,
  RANGE_COLUMNS,
  filterByRanges,
  rangeChipLabel,
  rangesActive,
  type InboxRanges,
} from "@/lib/tools/analytics/inbox-ranges.ts";
import { EXTRAS_NOTE_LOADING, EXTRAS_NOTE_READY, withExtras, type InboxExtras } from "@/lib/tools/analytics/inbox-extras.ts";
import { fullStamp } from "@/lib/workspace/dates";

import { INBOXES_URL, INBOX_EXTRAS_URL, useAnalyticsData } from "./actions";
import {
  ColumnPicker,
  EmptyRow,
  LoadError,
  Pager,
  Search,
  SortHeader,
  sortRows,
  useColumnPrefs,
  useSort,
  type SortState,
} from "./shared";
import { AddInboxesDialog } from "./add-inboxes-dialog";
import { RemoveInboxesDialog } from "./remove-inboxes-dialog";
import { StalenessStrip } from "./staleness-strip";
import { Btn } from "./toast";

/*
 * Inboxes (13 Oct) — every sending inbox in one table.
 *
 * The client's reference is Instantly's email-accounts list: a search box, a
 * row of filters, a count, and a table you can sort by any column. This is
 * that, over the inboxes the sync already holds.
 *
 * THE WHOLE LIST IS LOADED ONCE and searched, filtered, sorted and paged here
 * in the browser. Infrastructure pages its inbox table on the server, which
 * suits a table with one sort and five filters; this one filters on six
 * things and sorts on every column, and ~1,700 rows is small enough that
 * asking the server again for each combination would only make every click
 * slower.
 *
 * THE ONE THING HERE THAT CHANGES ANYTHING is Remove from campaigns (5 Nov), for a
 * selection of inboxes: a tag is the Tags filter and then Select all. It reads and
 * shows what it would do first — remove-inboxes-dialog.tsx. It changes campaigns,
 * so it needs Campaign Management as well as this page's own switch.
 *
 * What each filter matches, what an option counts and what a column sorts by
 * are in lib/tools/analytics/inboxes.ts, where they are tested.
 *
 * POSITIVE REPLIES AND DOMAINS (14 Nov): "the domains and inboxes that get the
 * most replies and positive replies", positive meaning what the team marked
 * Interested in Master Inbox. Two columns on every inbox (inbox-positives.ts
 * says what counts and for which inbox), and a Domains view that adds up the
 * inboxes the filters leave, one row per sending domain, most positive replies
 * first (inbox-domains.ts). A domain opens its inboxes.
 */

const PAGE_SIZE = 50;

type InboxView = "inboxes" | "domains";
/** Marks the history entry this page adds when a domain is opened. */
const DRILL_MARK = "inboxesDomainOpened";
/** A domain opened from the Domains view, and the Domain filter it replaced. */
interface OpenedDomain {
  domain: string;
  before: string[];
}
/** The Domains view answers "which domains get the most positive replies" before anything is clicked. */
const DOMAIN_DEFAULT_SORT: SortState = { key: "positive", dir: "desc" };
/**
 * Tags drawn in a cell before the rest fold into "+2". Two, on ONE line: three
 * chips in a narrow column stacked one per line and made every row 123px tall
 * — a table of 2,400 inboxes showing six of them at a time.
 */
const TAGS_SHOWN = 2;
const NO_ROWS: InboxRow[] = [];
const PLATFORMS: InboxPlatform[] = ["emailbison", "instantly"];

interface ExtrasAnswer {
  status: "ready" | "loading" | "refreshing" | "error";
  extras: InboxExtras | null;
  progress: { step: string; done: number; total: number } | null;
  error: string | null;
}

/** How often to ask again while EmailBison is still being read, and for how long. */
const EXTRAS_POLL_MS = 8000;
const EXTRAS_POLL_LIMIT = 120;

/*
 * Warmup scores and exact assignment, which come from EmailBison rather than
 * the database and take a few minutes the first time (inbox-extras-load.ts).
 * Asked for once the page is up, then again every few seconds until the read
 * is finished — the table is usable throughout and fills in by itself.
 */
function useInboxExtras(again: number): ExtrasAnswer | null {
  const [answer, setAnswer] = useState<ExtrasAnswer | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asked = 0;
    const ask = async () => {
      asked++;
      try {
        const res = await fetch(INBOX_EXTRAS_URL, { cache: "no-store", credentials: "same-origin" });
        const body = (await res.json()) as ExtrasAnswer;
        if (!live) return;
        setAnswer(res.ok ? body : { status: "error", extras: null, progress: null, error: body?.error ?? `HTTP ${res.status}` });
        const pending = res.ok && (body.status === "loading" || body.status === "refreshing");
        if (pending && asked < EXTRAS_POLL_LIMIT) timer = setTimeout(ask, EXTRAS_POLL_MS);
      } catch (e) {
        if (live) setAnswer({ status: "error", extras: null, progress: null, error: e instanceof Error ? e.message : "Could not reach the server" });
      }
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [again]);
  return answer;
}

export function InboxesScreen({ canChangeCampaigns = false }: { canChangeCampaigns?: boolean }) {
  const { data, error, loading } = useAnalyticsData<InboxesResponse>(INBOXES_URL);
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  // Lowest / highest on the number columns (inbox-ranges.ts).
  const [ranges, setRanges] = useState<InboxRanges>(NO_RANGES);
  const { sort, toggle } = useSort();
  // The Domains view keeps its own sort and page, so each view is where it was left.
  const domainSorting = useSort(DOMAIN_DEFAULT_SORT);
  const [view, setView] = useState<InboxView>("inboxes");
  const [visible, setVisible] = useColumnPrefs(
    INBOX_COLUMN_PREFS_KEY,
    INBOX_COLUMN_PREFS_VERSION,
    INBOX_DEFAULT_VISIBLE,
    INBOX_COLUMNS_ADDED,
  );
  const section = useRef<HTMLElement | null>(null);

  /*
   * THE ADDRESS FOLLOWS THE VIEW, so what a person sees is what they share:
   * `?view=domains` is the Domains view, `?domain=x.com` one domain's inboxes,
   * nothing the Inboxes view. Switching views replaces the address; opening a
   * domain adds one, so the browser's Back returns to the domains — with the
   * Domain filter as it was before, not left on the one domain. Read after the
   * first render: the server cannot see it.
   */
  // The ref holds what Back must restore; the state only what the screen draws.
  const openedRef = useRef<OpenedDomain | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const address = (change: (q: URLSearchParams) => void, push = false) => {
    try {
      const url = new URL(window.location.href);
      change(url.searchParams);
      // A step this page adds is marked, so "← All domains" knows Back leads to the domains, not off the page.
      if (push) window.history.pushState({ ...window.history.state, [DRILL_MARK]: true }, "", url);
      else window.history.replaceState(window.history.state, "", url);
    } catch {
      // The view still changes; only the address does not follow.
    }
  };
  /** Leaves an opened domain: its Domain filter goes back to what it was, unless it has since been changed. */
  const closeDomain = useCallback(() => {
    const o = openedRef.current;
    openedRef.current = null;
    setOpened(null);
    if (o) setFilters((f) => (f.domain.length === 1 && f.domain[0] === o.domain ? { ...f, domain: o.before } : f));
  }, []);
  /** Opens a domain the address names (a shared link, or Forward after Back), keeping the filter it replaces. */
  const showDomain = useCallback((domain: string, before: string[]) => {
    if (openedRef.current?.domain !== domain) openedRef.current = { domain, before };
    setOpened(domain);
    setFilters((f) => ({ ...f, domain: [domain] }));
    setView("inboxes");
  }, []);
  // The Domain filter as it stands, for a domain opened from the address to put back on Back.
  const domainFilter = useRef<string[]>([]);
  domainFilter.current = filters.domain;
  const fromAddress = useCallback(() => {
    const q = new URLSearchParams(window.location.search);
    const domain = q.get("domain")?.trim().toLowerCase();
    if (q.get("view") === "domains") {
      closeDomain();
      setView("domains");
    } else if (domain) {
      showDomain(domain, domainFilter.current);
    } else {
      closeDomain();
      setView("inboxes");
    }
  }, [closeDomain, showDomain]);
  useEffect(() => {
    fromAddress();
    window.addEventListener("popstate", fromAddress);
    return () => window.removeEventListener("popstate", fromAddress);
  }, [fromAddress]);
  const chooseView = (next: InboxView) => {
    if (next === "domains") closeDomain();
    setView(next);
    address((q) => {
      q.delete("domain");
      if (next === "domains") q.set("view", "domains");
      else q.delete("view");
    });
  };
  /*
   * By inbox id, not by row position, so a selection survives sorting,
   * filtering and paging: ticking five, sorting by Sent and coming back must
   * not have ticked a different five.
   */
  const [selected, setSelected] = useState<Set<number | string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false);
  // Asks EmailBison's figures again after inboxes have come off campaigns.
  const [readAgain, setReadAgain] = useState(0);

  const extras = useInboxExtras(readAgain);
  // The database's rows with EmailBison's warmup scores and exact assignment
  // laid over them once those have been read.
  const all = useMemo(() => withExtras(data?.rows ?? NO_ROWS, extras?.extras ?? null), [data, extras]);
  const notes = useMemo(() => {
    const said = inboxNotes(data?.notes ?? [], extras, data?.positivesAsOf ?? null);
    if (view !== "domains") return said;
    // On the Domains view, what a domain row is comes first, then what "positive" means.
    return [DOMAINS_NOTE, ...said.filter(isPositiveNote), ...said.filter((n) => !isPositiveNote(n))];
  }, [data, extras, view]);
  const perPlatform = useMemo(() => {
    const counts = new Map<InboxPlatform, number>();
    for (const row of all) counts.set(row.platform, (counts.get(row.platform) ?? 0) + 1);
    return counts;
  }, [all]);
  /*
   * Platform is a filter and a column only when there is more than one. With
   * EmailBison alone, both would be a control with a single answer.
   */
  const multiPlatform = perPlatform.size > 1;
  const facets = useMemo(() => INBOX_FACETS.filter((f) => f !== "platform" || multiPlatform), [multiPlatform]);

  /*
   * The number filters first, then the tick filters over what is left — so a
   * tick filter's options count the inboxes that would actually be listed.
   */
  const inRange = useMemo(() => filterByRanges(all, ranges), [all, ranges]);
  const matching = useMemo(() => filterInboxes(inRange, filters), [inRange, filters]);
  const sorted = useMemo(() => sortRows(matching, sort, inboxSortValue), [matching, sort]);
  const options = useMemo(() => {
    const out = {} as Record<InboxFacet, FacetOption[]>;
    for (const f of INBOX_FACETS) out[f] = facetOptions(inRange, filters, f);
    return out;
  }, [inRange, filters]);

  /*
   * Page derived during render, not reset from an effect: a filter or a sort
   * moves back to page 1 without drawing the stale page once first.
   *
   * And forgotten, not just hidden (14 Nov): reading page 2, choosing a filter
   * and clearing it again brought page 2 back, because the key matched again.
   * Setting state while rendering is React's own pattern for this; it renders
   * again at once, before anything is drawn.
   */
  const viewKey = `${JSON.stringify(filters)}|${JSON.stringify(ranges)}|${sort?.key ?? ""}|${sort?.dir ?? ""}`;
  const [pageState, setPageState] = useState({ key: viewKey, page: 1 });
  if (pageState.key !== viewKey) setPageState({ key: viewKey, page: 1 });
  const page = pageState.key === viewKey ? pageState.page : 1;
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // One row per domain of the inboxes the filters leave; the total is of every inbox.
  const domains = useMemo(() => domainRows(matching), [matching]);
  const domainTotal = useMemo(() => domainRows(all).length, [all]);
  // Addresses, as the Inboxes column counts them: a mailbox on both platforms is one inbox here.
  const domainInboxes = useMemo(() => domains.reduce((n, d) => n + d.inboxes, 0), [domains]);
  const domainSorted = useMemo(
    () => sortRows(domains, domainSorting.sort, domainSortValue),
    [domains, domainSorting.sort],
  );
  const domainViewKey = `${JSON.stringify(filters)}|${JSON.stringify(ranges)}|${domainSorting.sort?.key ?? ""}|${domainSorting.sort?.dir ?? ""}`;
  const [domainPageState, setDomainPageState] = useState({ key: domainViewKey, page: 1 });
  if (domainPageState.key !== domainViewKey) setDomainPageState({ key: domainViewKey, page: 1 });
  const domainPage = domainPageState.key === domainViewKey ? domainPageState.page : 1;
  const domainPageRows = domainSorted.slice((domainPage - 1) * PAGE_SIZE, domainPage * PAGE_SIZE);

  /** A domain's inboxes: the Domain filter set to it, the rest of the filters kept, and a step Back can undo. */
  const openDomain = (domain: string) => {
    openedRef.current = { domain, before: filters.domain };
    setOpened(domain);
    setFilters((f) => ({ ...f, domain: [domain] }));
    setView("inboxes");
    address((q) => {
      q.delete("view");
      q.set("domain", domain);
    }, true);
    // From a long list the inbox table is short: bring its top into view.
    requestAnimationFrame(() => section.current?.scrollIntoView({ block: "nearest" }));
  };
  /**
   * "← All domains": the browser's own Back when this page added the step, so
   * the two always agree. Arrived at from a link, Back would leave the page:
   * then it switches views instead.
   */
  const backToDomains = () => {
    if ((window.history.state as Record<string, unknown> | null)?.[DRILL_MARK]) window.history.back();
    else chooseView("domains");
  };

  const available = useMemo(
    () => INBOX_COLUMNS.filter((c) => multiPlatform || c.key !== "platform"),
    [multiPlatform],
  );
  const columns = available.filter((c) => visible.includes(c.key));
  const isAvailable = (key: string) => available.some((c) => c.key === key);

  if (error && !data) return <LoadError what="Inboxes" error={error} />;

  const filtered = filtersActive(filters) || rangesActive(ranges) > 0;
  const pageIds = rows.map((r) => r.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const togglePage = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  const toggleRow = (id: number | string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const emailSorted = sort?.key === "email";

  // A selection survives filtering, so some of it may be out of view: said, because it is about to be acted on.
  const selectedInView = matching.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0);
  const selectedHidden = selected.size - selectedInView;
  const canSelectAll = matching.length > selectedInView && (filtered || allOnPageSelected);
  const selectAll = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const r of matching) next.add(r.id);
      return next;
    });
  // EmailBison's ids are numbers; an Instantly inbox's id is its address.
  const selectedEmailBison = [...selected].filter((id): id is number => typeof id === "number");
  const selectedInstantly = selected.size - selectedEmailBison.length;

  return (
    <div className="an-screen">
      <StalenessStrip />
      <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="ds-title">Inboxes</h1>
            <div className="tbl-sub">
              {data
                ? [
                    // The split only when there is one to show, EmailBison first.
                    ...(multiPlatform
                      ? PLATFORMS.filter((p) => perPlatform.has(p)).map((p) => `${PLATFORM_LABEL[p]} ${fullNumber(perPlatform.get(p))}`)
                      : []),
                    data.asOf ? `Synced ${fullStamp(data.asOf)} ET` : "Sync time not recorded",
                  ].join(" · ")
                : "Loading…"}
            </div>
          </div>
          {/* The count, large, where Instantly's own list puts it — of what the view lists. */}
          <div style={{ whiteSpace: "nowrap" }} data-inbox-total>
            <span
              className="tnum"
              style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-.02em", lineHeight: 1.1, color: "var(--ink)" }}
            >
              {data ? fullNumber(view === "domains" ? domainTotal : data.total) : DASH}
            </span>
            <span className="mut" style={{ marginLeft: 8, fontSize: 14 }}>
              {view === "domains"
                ? domainTotal === 1 ? "domain" : "domains"
                : data?.total === 1 ? "inbox" : "inboxes"}
            </span>
          </div>
        </div>

        <div className="seg" role="tablist" aria-label="List by" style={{ marginBottom: 12 }}>
          {(["inboxes", "domains"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? "on" : undefined}
              data-inbox-view={v}
              onClick={() => chooseView(v)}
            >
              {v === "inboxes" ? "Inboxes" : "Domains"}
            </button>
          ))}
        </div>

        <section ref={section} className="abox" style={{ marginBottom: 20, scrollMarginTop: 12 }}>
          <div
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "14px 18px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <Search
              value={filters.search}
              onChange={(search) => setFilters((f) => ({ ...f, search }))}
              placeholder="Search email, name or domain…"
              width={260}
            />
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
              {facets.map((f) => (
                <FacetFilter
                  key={f}
                  facet={f}
                  options={options[f]}
                  selected={filters[f]}
                  onChange={(next) => setFilters((cur) => ({ ...cur, [f]: next }))}
                />
              ))}
              <RangeFilter value={ranges} onChange={setRanges} domains={view === "domains"} />
            </span>
          </div>

          {/*
            Always present and one height, so the table does not jump when a
            filter or a first tick adds something to this line.
          */}
          <div
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "8px 18px",
              minHeight: 52, boxSizing: "border-box", borderBottom: "1px solid var(--line-soft)", fontSize: 13,
            }}
          >
            {view === "inboxes" && opened ? (
              <button type="button" className="gh" data-inbox-back onClick={backToDomains} title="Back to the Domains view, with the filters you had there">
                ← All domains
              </button>
            ) : null}
            <span className="tnum" role="status" data-inbox-count style={{ color: "var(--ink-2)" }}>
              {!data
                ? "Loading inboxes…"
                : view === "domains"
                  ? `${filtered ? `${fullNumber(domains.length)} of ` : ""}${fullNumber(domainTotal)} ${domainTotal === 1 ? "domain" : "domains"} · ${fullNumber(domainInboxes)} ${domainInboxes === 1 ? "inbox" : "inboxes"}`
                  : filtered
                    ? `${fullNumber(matching.length)} of ${fullNumber(all.length)} inboxes`
                    : `${fullNumber(all.length)} ${all.length === 1 ? "inbox" : "inboxes"}`}
            </span>
            {filtered ? (
              <button
                type="button"
                className="gh"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  setRanges(NO_RANGES);
                }}
              >
                Clear filters
              </button>
            ) : null}
            {/* Selecting is for acting on inboxes; the Domains view lists none to tick. */}
            {view === "inboxes" && canSelectAll ? (
              <button type="button" className="gh tnum" data-inbox-select-all onClick={selectAll}>
                Select all {fullNumber(matching.length)}
              </button>
            ) : null}
            {/*
              The right-hand group — the selection's actions, Loading and
              Columns — moves as one: on a line too full (filters, a domain
              opened and a selection) it wraps whole, still at the right,
              rather than stranding a button at the left of a second line.
            */}
            <span
              style={{
                display: "inline-flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end",
                gap: 10, marginLeft: "auto",
              }}
            >
            {view === "inboxes" && selected.size > 0 ? (
              <>
                <span className="tnum mut" data-inbox-selected>
                  {fullNumber(selected.size)} selected{selectedHidden > 0 ? ` · ${fullNumber(selectedHidden)} not in this view` : ""}
                </span>
                <button type="button" className="gh" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
                {canChangeCampaigns ? (
                  <button
                    type="button"
                    className="gh an-add-open"
                    data-inbox-add
                    disabled={!selectedEmailBison.length}
                    title={selectedEmailBison.length ? undefined : "This adds EmailBison inboxes. The ones selected are Instantly's."}
                    onClick={() => setAdding(true)}
                  >
                    Add to campaigns
                  </button>
                ) : null}
                {canChangeCampaigns ? (
                  <button
                    type="button"
                    className="gh an-rm-open"
                    data-inbox-remove
                    disabled={!selectedEmailBison.length}
                    title={selectedEmailBison.length ? undefined : "This removes EmailBison inboxes. The ones selected are Instantly's."}
                    onClick={() => setRemoving(true)}
                  >
                    Remove from campaigns
                  </button>
                ) : null}
              </>
            ) : null}
            {/*
              Loading and Columns sit on this line, above the table they are
              about (14 Nov). In the filter bar they wrapped onto a line of
              their own below 1,540px, which the Domains view — whose columns
              are fixed — left as an empty band.
            */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {/* Always in the layout, only shown while loading: appearing and
                  disappearing, it would shift this line. */}
              <span className="mut" aria-hidden={!loading} style={{ fontSize: 12, visibility: loading ? "visible" : "hidden" }}>
                Loading…
              </span>
              {/* A domain has no tags, status or warmup to choose. Hidden, not
                  removed, so nothing moves on a switch; hidden is also out of
                  the tab order. */}
              <span aria-hidden={view !== "inboxes"} style={{ visibility: view === "inboxes" ? "visible" : "hidden" }}>
                <ColumnPicker
                  groups={INBOX_COLUMN_GROUPS}
                  columns={available}
                  visible={visible.filter(isAvailable)}
                  // A column that is not on offer right now (Platform, with one
                  // platform) keeps whatever was chosen for it.
                  onChange={(next) => setVisible([...next, ...visible.filter((k) => !isAvailable(k))])}
                />
              </span>
            </span>
            </span>
          </div>

          {view === "domains" ? (
            <DomainTable
              rows={domainPageRows}
              sort={domainSorting.sort}
              onSort={domainSorting.toggle}
              onOpen={openDomain}
              loaded={!!data}
              anyInboxes={all.length > 0}
              dim={loading && !!data}
            />
          ) : (
            <div className="tbl-scroll" style={{ opacity: loading && data ? 0.7 : 1, transition: "opacity .14s" }}>
              <table className="atbl" style={{ minWidth: 320 + columns.length * 132, width: "100%" }}>
                <thead>
                  <tr>
                    {/* The identity column stays pinned so a row never loses its
                        inbox while scrolling sideways. */}
                    <th
                      style={{ position: "sticky", left: 0, zIndex: 2, minWidth: 280, background: "var(--surface)" }}
                      aria-sort={emailSorted ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={allOnPageSelected}
                          onChange={togglePage}
                          aria-label={allOnPageSelected ? "Deselect this page" : "Select this page"}
                          style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                        />
                        <button
                          type="button"
                          onClick={() => toggle("email")}
                          title="Sort by Email"
                          style={{
                            border: 0, background: "none", font: "inherit", padding: 0, cursor: "pointer",
                            color: emailSorted ? "var(--ink)" : "inherit", fontWeight: emailSorted ? 600 : 500,
                            display: "inline-flex", alignItems: "center", gap: 4,
                          }}
                        >
                          Email
                          <span className="sort-ico" style={{ opacity: emailSorted ? 0.9 : 0.28 }}>
                            {emailSorted ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      </span>
                    </th>
                    {columns.map((c) => (
                      <SortHeader
                        key={c.key}
                        label={c.label}
                        sortKey={c.key}
                        sort={sort}
                        onToggle={toggle}
                        align={c.align}
                        title={c.hint}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!data ? (
                    <EmptyRow colSpan={columns.length + 1}>Loading inboxes…</EmptyRow>
                  ) : rows.length === 0 ? (
                    <EmptyRow colSpan={columns.length + 1}>
                      {all.length === 0
                        ? "No inboxes have been synced yet. The inbox sync runs every three hours."
                        : "No inboxes match these filters."}
                    </EmptyRow>
                  ) : (
                    rows.map((row) => (
                      <tr key={String(row.id)}>
                        <td style={{ position: "sticky", left: 0, zIndex: 1, minWidth: 280, maxWidth: 360, background: "var(--surface)" }}>
                          <span style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <input
                              type="checkbox"
                              checked={selected.has(row.id)}
                              onChange={() => toggleRow(row.id)}
                              aria-label={`Select ${row.email}`}
                              style={{ accentColor: "var(--blue)", cursor: "pointer", marginTop: 3 }}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span
                                title={row.email}
                                style={{ display: "block", fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              >
                                {row.email}
                              </span>
                              {row.name ? (
                                <span className="mut" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {row.name}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={c.align === "right" ? "tnum" : undefined}
                            style={{ textAlign: c.align === "right" ? "right" : "left" }}
                          >
                            {cell(row, c.key)}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
          {!data ? null : view === "domains" ? (
            <Pager
              page={domainPage}
              pageSize={PAGE_SIZE}
              total={domainSorted.length}
              onPage={(next) => setDomainPageState({ key: domainViewKey, page: next })}
            />
          ) : (
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={sorted.length}
              onPage={(next) => setPageState({ key: viewKey, page: next })}
            />
          )}
        </section>

        {/* What a column means and what could not be supplied, in the route's
            own words — so the page and the data cannot drift apart. */}
        {data && notes.length ? (
          <div data-inbox-notes data-inbox-extras={extras?.status ?? "asking"} style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
            {notes.map((note) => (
              <p key={note} style={{ margin: "0 0 6px" }}>{note}</p>
            ))}
          </div>
        ) : null}
      </div>
      {adding ? (
        <AddInboxesDialog
          inboxes={all.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, status: r.status }))}
          onClose={(changed) => {
            setAdding(false);
            if (!changed) return;
            setSelected(new Set());
            setReadAgain((n) => n + 1);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveInboxesDialog
          inboxIds={selectedEmailBison}
          leftOut={selectedInstantly}
          onClose={(changed) => {
            setRemoving(false);
            if (!changed) return;
            setSelected(new Set());
            setReadAgain((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

const DOMAINS_NOTE =
  "Each domain adds up its inboxes that match the filters. Inboxes counts addresses: a mailbox connected to " +
  "both EmailBison and Instantly is one inbox, and its sends and replies on both are added.";
const isPositiveNote = (n: string) => /positive repl/i.test(n);
/** How the route's note on Replies (Master Inbox) and Positive replies begins (inboxes/route.ts NOTE_POSITIVE). */
export const POSITIVE_NOTE_START = "Replies (Master Inbox) counts";

/*
 * The notes under the table: the route's own, with the ones about Warmup and
 * Assigned replaced by what is true now that EmailBison has (or has not yet)
 * answered.
 */
function inboxNotes(fromRoute: string[], extras: ExtrasAnswer | null, positivesAsOf: string | null): string[] {
  const about = (prefix: string) => (n: string) => n.startsWith(prefix);
  // The definition gains when Master Inbox was read, so a number can be checked against a moment.
  fromRoute = fromRoute.map((n) =>
    positivesAsOf && n.startsWith(POSITIVE_NOTE_START) ? `${n} Read from Master Inbox ${fullStamp(positivesAsOf)} ET.` : n,
  );
  const isWarmup = about("Warmup 3d / 7d");
  const isAssigned = about("Assigned");
  if (extras?.extras) {
    const when = `${EXTRAS_NOTE_READY} Last read ${fullStamp(extras.extras.asOf)} ET${extras.status === "refreshing" ? "; a fresh read is running now" : ""}.`;
    return [when, ...fromRoute.filter((n) => !isWarmup(n) && !isAssigned(n))];
  }
  if (extras?.status === "error") {
    return [
      `Warmup scores and exact campaign assignment could not be read from EmailBison just now (${extras.error ?? "no answer"}). Warmup shows a dash and Assigned is estimated from the send history; the next visit tries again.`,
      ...fromRoute.filter((n) => !isWarmup(n)),
    ];
  }
  const progress = extras?.progress ? ` (${extras.progress.step}: ${extras.progress.done} of ${extras.progress.total})` : "";
  return [`${EXTRAS_NOTE_LOADING}${progress}`, ...fromRoute.filter((n) => !isWarmup(n))];
}

/** One cell. A value that is not known is a dash — never 0, never "No". */
function cell(row: InboxRow, key: string): React.ReactNode {
  switch (key) {
    case "tags":
      return <TagChips tags={row.tags} />;
    case "type":
      return row.type ?? DASH;
    case "status":
      return row.status ? <span className={`badge ${statusTone(row.status)}`}>{row.status}</span> : DASH;
    case "dailyLimit":
      return fullNumber(row.dailyLimit);
    case "sent":
      return fullNumber(row.sentAllTime);
    case "replied":
      return fullNumber(row.repliedAllTime);
    case "miReplies":
      return fullNumber(row.masterInboxReplies);
    case "positive":
      return fullNumber(row.positiveAllTime);
    case "positiveRate":
      return percent(positiveRate(row), 1);
    case "bounced":
      return fullNumber(row.bouncedAllTime);
    case "warmup":
      return row.warmupEnabled === null ? DASH : row.warmupEnabled ? "On" : "Off";
    case "warmup3d":
      return fullNumber(row.warmup3d);
    case "warmup7d":
      return fullNumber(row.warmup7d);
    case "vendor":
      // "Untagged" is a finding on EmailBison, where every vendor has a tag.
      // Instantly's tags name no vendor at all, so there it is simply unknown.
      if (row.vendor) return row.vendor;
      return row.platform === "emailbison" ? <span className="mut">Untagged</span> : DASH;
    case "assigned":
      if (row.assignedToCampaign === null) return DASH;
      return row.assignedToCampaign ? <span className="badge s-done">Yes</span> : <span className="mut">No</span>;
    case "platform":
      return PLATFORM_LABEL[row.platform];
    default:
      return DASH;
  }
}

/*
 * The Domains view: one row per sending domain of the inboxes the filters
 * leave (inbox-domains.ts), most positive replies first. A domain's name opens
 * its inboxes. A sum that left inboxes out — their figure not known — says how
 * many on hover.
 */
function DomainTable({
  rows,
  sort,
  onSort,
  onOpen,
  loaded,
  anyInboxes,
  dim,
}: {
  rows: DomainRow[];
  sort: SortState | null;
  onSort: (key: string) => void;
  onOpen: (domain: string) => void;
  loaded: boolean;
  anyInboxes: boolean;
  dim: boolean;
}) {
  const nameSorted = sort?.key === "domain";
  return (
    <div className="tbl-scroll" style={{ opacity: dim ? 0.7 : 1, transition: "opacity .14s" }}>
      <table className="atbl" data-inbox-domains style={{ minWidth: 220 + DOMAIN_COLUMNS.length * 110, width: "100%" }}>
        <thead>
          <tr>
            <th
              style={{ position: "sticky", left: 0, zIndex: 2, minWidth: 220, background: "var(--surface)" }}
              aria-sort={nameSorted ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
            >
              <button
                type="button"
                onClick={() => onSort("domain")}
                title="Sort by Domain"
                style={{
                  border: 0, background: "none", font: "inherit", padding: 0, cursor: "pointer",
                  color: nameSorted ? "var(--ink)" : "inherit", fontWeight: nameSorted ? 600 : 500,
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}
              >
                Domain
                <span className="sort-ico" style={{ opacity: nameSorted ? 0.9 : 0.28 }}>
                  {nameSorted ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </button>
            </th>
            {DOMAIN_COLUMNS.map((c) => (
              <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onToggle={onSort} align="right" title={c.hint} />
            ))}
          </tr>
        </thead>
        <tbody>
          {!loaded ? (
            <EmptyRow colSpan={DOMAIN_COLUMNS.length + 1}>Loading inboxes…</EmptyRow>
          ) : rows.length === 0 ? (
            <EmptyRow colSpan={DOMAIN_COLUMNS.length + 1}>
              {anyInboxes ? "No domains match these filters." : "No inboxes have been synced yet. The inbox sync runs every three hours."}
            </EmptyRow>
          ) : (
            rows.map((d) => (
              <tr key={d.domain} data-domain={d.domain}>
                <td style={{ position: "sticky", left: 0, zIndex: 1, minWidth: 220, maxWidth: 340, background: "var(--surface)" }}>
                  <button
                    type="button"
                    className="cname-open"
                    onClick={() => onOpen(d.domain)}
                    title={`Show the ${d.inboxes === 1 ? "inbox" : `${fullNumber(d.inboxes)} inboxes`} on ${d.domain}`}
                    style={{
                      display: "block", maxWidth: "100%", fontWeight: 600, color: "var(--ink)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    {d.domain}
                  </button>
                </td>
                {DOMAIN_COLUMNS.map((c) => (
                  <td key={c.key} className="tnum" style={{ textAlign: "right" }}>
                    {domainCell(d, c.key)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A figure that left out inboxes whose figure is not known, saying so on hover. */
function partial(value: number | null, missing: number): React.ReactNode {
  if (value === null || missing === 0) return fullNumber(value);
  return (
    <span title={`${fullNumber(missing)} ${missing === 1 ? "inbox has" : "inboxes have"} no figure here and ${missing === 1 ? "is" : "are"} not in this total`} style={{ cursor: "help" }}>
      {fullNumber(value)}
    </span>
  );
}

function domainCell(d: DomainRow, key: string): React.ReactNode {
  switch (key) {
    case "inboxes":
      return fullNumber(d.inboxes);
    case "sent":
      return partial(d.sentAllTime, d.missing.sent);
    case "miReplies":
      return partial(d.masterInboxReplies, d.missing.replies);
    case "positive":
      return partial(d.positiveAllTime, d.missing.positive);
    case "positiveRate":
      return percent(positiveRate(d), 1);
    default:
      return DASH;
  }
}

function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return <>{DASH}</>;
  const shown = tags.slice(0, TAGS_SHOWN);
  const more = tags.length - shown.length;
  return (
    <span
      // Every tag, always: a chip may be cut short and the rest are folded away.
      title={tags.join(", ")}
      style={{ display: "inline-flex", flexWrap: "nowrap", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
    >
      {shown.map((tag, i) => (
        // `.schip` is a button's look. These are labels, so no hover or press.
        <span
          key={`${tag}-${i}`}
          className="schip"
          style={{ padding: "2px 8px", fontSize: 12, cursor: "default", pointerEvents: "none", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block" }}
        >
          {tag}
        </span>
      ))}
      {more > 0 ? <span className="mut" style={{ fontSize: 12 }}>+{more}</span> : null}
    </span>
  );
}

/*
 * The number filters: one chip, a lowest and a highest for each number column.
 * They apply as they are typed — the rows are already in the browser — and a
 * box that is empty or half-typed filters nothing (inbox-ranges.ts).
 */
function RangeFilter({ value, onChange, domains = false }: { value: InboxRanges; onChange: (next: InboxRanges) => void; domains?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const active = rangesActive(value) > 0;
  const set = (key: keyof InboxRanges, end: "min" | "max", text: string) =>
    onChange({ ...value, [key]: { ...value[key], [end]: text } });

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button"
        className={`schip${active ? "" : " off"}`}
        aria-pressed={active}
        aria-expanded={open}
        data-inbox-filter="numbers"
        title="Filter by daily limit, sent, replied, Master Inbox replies, positive replies, bounced or warmup score"
        onClick={() => setOpen((v) => !v)}
        style={{ maxWidth: 260 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rangeChipLabel(value)}</span>{" "}
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={340} align="start" label="Filter by number">
        <div data-inbox-filter-panel="numbers" style={{ padding: 14, display: "grid", gap: 10 }}>
          <div className="grp-h" style={{ padding: 0 }}>Numbers</div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px 84px", gap: "8px 8px", alignItems: "center", fontSize: 13 }}>
            <span />
            <span className="mut" style={{ fontSize: 11.5 }}>At least</span>
            <span className="mut" style={{ fontSize: 11.5 }}>At most</span>
            {RANGE_COLUMNS.map(({ key, label }) => (
              <RangeRowInputs key={key} id={key} label={label} min={value[key].min} max={value[key].max} onChange={(end, text) => set(key, end, text)} />
            ))}
          </div>
          <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>
            An inbox with a dash in a column is left out when that column is filtered.
            {domains ? " On Domains these pick inboxes, and each domain adds up the ones left — not domains by their totals." : ""}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <Btn disabled={!active} onClick={() => onChange(NO_RANGES)}>
              Clear
            </Btn>
            <Btn primary onClick={close}>
              Done
            </Btn>
          </div>
        </div>
      </AnchoredPanel>
    </span>
  );
}

function RangeRowInputs({
  id,
  label,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  min: string;
  max: string;
  onChange: (end: "min" | "max", text: string) => void;
}) {
  // `.inp` carries a 200px minimum that this grid cannot spare (the dialog-fields trap).
  const box: React.CSSProperties = { width: "100%", minWidth: 0, padding: "5px 8px", textAlign: "right" };
  return (
    <>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <input id={`inbox-range-${id}-min`} className="inp tnum" inputMode="numeric" aria-label={`${label}: at least`} value={min} onChange={(e) => onChange("min", e.target.value)} style={box} />
      <input id={`inbox-range-${id}-max`} className="inp tnum" inputMode="numeric" aria-label={`${label}: at most`} value={max} onChange={(e) => onChange("max", e.target.value)} style={box} />
    </>
  );
}

/*
 * One filter: a chip that opens a list of ticks, built the way the Leads
 * tab's Location filter is (see ui/anchored-panel.tsx for why the list is
 * portalled).
 *
 * A tick applies at once rather than waiting for an Apply button. Location
 * holds its ticks back because each change is a query; here the rows are
 * already in the browser, so the table can answer every tick as it is made.
 */
function FacetFilter({
  facet,
  options,
  selected,
  onChange,
}: {
  facet: InboxFacet;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const active = selected.length > 0;
  const name = FACET_LABEL[facet];

  const needle = typed.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button"
        className={`schip${active ? "" : " off"}`}
        aria-pressed={active}
        aria-expanded={open}
        data-inbox-filter={facet}
        onClick={() => {
          setTyped("");
          setOpen((v) => !v);
        }}
        // One long tag must not push the rest of the toolbar onto a new line.
        style={{ maxWidth: 260 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {facetChipLabel(facet, selected)}
        </span>{" "}
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={290} align="start" label={`Filter by ${name.toLowerCase()}`}>
        <div data-inbox-filter-panel={facet} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ padding: "14px 14px 10px", display: "grid", gap: 10 }}>
            <div className="grp-h" style={{ padding: 0 }}>{name}</div>
            {options.length > 8 ? (
              <input
                className="inp"
                type="search"
                placeholder="Find…"
                aria-label={`Find in ${name.toLowerCase()}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                // `.inp` carries a 200px minimum that a narrow panel cannot spare.
                style={{ width: "100%", minWidth: 0 }}
                autoFocus
              />
            ) : null}
          </div>

          <div
            style={{
              overflowY: "auto", flex: 1, minHeight: 60, maxHeight: 264, padding: "0 14px",
              borderTop: "1px solid var(--line-soft)", borderBottom: "1px solid var(--line-soft)",
            }}
          >
            {options.length === 0 ? (
              <div className="mut" style={{ padding: "18px 0", fontSize: 12.5 }}>Nothing to choose from yet.</div>
            ) : shown.length === 0 ? (
              <div className="mut" style={{ padding: "18px 0", fontSize: 12.5 }}>Nothing matches “{typed.trim()}”.</div>
            ) : (
              shown.map((o) => (
                <label
                  key={o.value}
                  style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 13, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(o.value)}
                    style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                    onChange={() => onChange(toggleValue(selected, o.value))}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.label}>
                    {o.label}
                  </span>
                  <span className="tnum mut" style={{ fontSize: 12 }}>{fullNumber(o.count)}</span>
                </label>
              ))
            )}
          </div>

          <div style={{ padding: "10px 14px 14px", display: "flex", justifyContent: "space-between", gap: 8 }}>
            <Btn disabled={!active} onClick={() => onChange([])}>
              Clear
            </Btn>
            <Btn primary onClick={close}>
              Done
            </Btn>
          </div>
        </div>
      </AnchoredPanel>
    </span>
  );
}
