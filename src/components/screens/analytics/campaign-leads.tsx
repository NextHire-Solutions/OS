"use client";

import { useMemo, useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import {
  LEAD_COLUMNS,
  LEAD_COLUMN_GROUPS,
  LEAD_COLUMN_PREFS_KEY,
  LEAD_COLUMN_PREFS_VERSION,
  LEAD_DEFAULT_VISIBLE,
  LEAD_STATUS_LABELS,
  type LeadRow,
} from "@/lib/tools/analytics/lead-columns.ts";
import { CAMPAIGN_LEADS_URL, selectAllLeadIds, useAnalyticsData } from "./actions";
import { RemoveLeadsDialog } from "./remove-leads-dialog";
import {
  ColumnPicker,
  EmptyRow,
  Pager,
  Search,
  SortHeader,
  useColumnPrefs,
  useDebounced,
  useSort,
} from "./shared";
import { Btn } from "./toast";

/*
 * Who this campaign has actually contacted — the tool's
 * `components/campaigns/campaign-leads.tsx`.
 *
 * Read-only apart from removal. Leads are added on the platform; this answers
 * "who is in it, how far did each get, and what came back" — which nothing in
 * the product could answer before, because lead→campaign membership was not
 * recorded anywhere.
 *
 * NO DATE RANGE. The campaign page has no filter bar, and membership is a
 * lifetime fact — a range here would quietly imply a lead outside it was never
 * contacted.
 *
 * Everything is server-side: search, status filter, sort and paging. A campaign
 * has thousands of leads and a `.select()` truncates at 1,000 rows in silence.
 */

const STATUS_TONE: Record<string, string> = {
  positive: "s-done",
  replied: "s-pending",
  bounced: "s-risk",
};

/*
 * The route's row. Instantly rows carry `firstName`/`lastName` and no `name`
 * — a different shape, not a subset — so the identity cell reads whichever is
 * there. Ids are integers for EmailBison and uuids for Instantly.
 */
interface Row extends Omit<LeadRow, "leadId" | "name"> {
  leadId: number | string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface Response {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  facets: Array<{ status: string; leads: number }>;
}

const nameOf = (r: Row) => r.name ?? ([r.firstName, r.lastName].filter(Boolean).join(" ") || null);

export function CampaignLeads({
  campaignId,
  campaignName,
  platformName,
}: {
  /** Text: an EmailBison bigint or an Instantly uuid. */
  campaignId: string;
  campaignName: string;
  platformName: string;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim());
  const [status, setStatus] = useState<string | null>(null);
  const [visible, setVisible] = useColumnPrefs(
    LEAD_COLUMN_PREFS_KEY,
    LEAD_COLUMN_PREFS_VERSION,
    LEAD_DEFAULT_VISIBLE,
  );
  const { sort, toggle } = useSort();

  /*
   * Selection is by lead id, not by row index, so it survives paging, sorting
   * and re-fetching. Selecting 40 on page 1, paging away and back must not
   * silently select a different 40.
   */
  const [selected, setSelected] = useState<Set<number | string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);

  /*
   * Page derived during render, not reset from an effect: a filter change
   * moves back to page 1 without rendering the stale page once first.
   */
  const filterKey = `${debounced}|${status}|${sort?.key ?? ""}|${sort?.dir ?? ""}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;

  const params = new URLSearchParams({ page: String(page) });
  if (debounced) params.set("q", debounced);
  if (status) params.append("status", status);
  if (sort) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }

  /*
   * Keyed on the campaign alone, so the status counts survive paging, sorting
   * and searching instead of being recomputed with every one of them.
   */
  const facetQuery = useAnalyticsData<{ facets: Array<{ status: string; leads: number }> }>(
    CAMPAIGN_LEADS_URL(campaignId, "facets=1&page=1"),
  );
  const { data, loading, error, reload } = useAnalyticsData<Response>(
    CAMPAIGN_LEADS_URL(campaignId, params.toString()),
  );

  const columns = useMemo(() => LEAD_COLUMNS.filter((c) => visible.includes(c.key)), [visible]);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const facets = facetQuery.data?.facets ?? [];
  /*
   * "Removed" is excluded from the All count on purpose. It is not one of the
   * live statuses — a removed lead was also bounced or replied or completed —
   * so adding it would make All exceed the number of leads on the campaign.
   */
  const facetTotal = facets
    .filter((f) => f.status !== "removed")
    .reduce((n, f) => n + Number(f.leads), 0);

  const pageIds = rows.map((r) => r.leadId);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const viewingRemoved = status === "removed";

  const toggleOne = (leadId: number | string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(leadId)) next.delete(leadId); else next.add(leadId);
      return next;
    });

  const togglePage = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });

  /*
   * Selecting beyond the page asks the SERVER for the matching ids rather than
   * assembling them from pages the browser has seen. Anything else would select
   * the 50 rows currently loaded while the button said 6,288 — and the removal
   * would then take a different set from the one the dialog named.
   */
  const selectAllMatching = async () => {
    setLoadingAll(true);
    setSelectError(null);
    try {
      setSelected(new Set(await selectAllLeadIds(campaignId, debounced, status)));
    } catch (e) {
      setSelectError(e instanceof Error ? e.message : "Could not load the full selection");
    } finally {
      setLoadingAll(false);
    }
  };

  const afterRemoval = () => {
    setSelected(new Set());
    void reload();
    void facetQuery.reload();
  };

  return (
    <section className="abox" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--line-soft)" }}>
        <Search value={search} onChange={setSearch} placeholder="Search name, email or company…" width={260} />

        {/* Counts on the chips, so "how many bounced" is answered without
            clicking through each one. */}
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
          <button type="button" className={`schip${status === null ? "" : " off"}`} aria-pressed={status === null} onClick={() => setStatus(null)}>
            All {facetTotal ? <span className="tnum">{fullNumber(facetTotal)}</span> : null}
          </button>
          {facets.map((f) => (
            <button
              key={f.status}
              type="button"
              className={`schip${status === f.status ? "" : " off"}`}
              aria-pressed={status === f.status}
              onClick={() => setStatus(status === f.status ? null : f.status)}
            >
              {LEAD_STATUS_LABELS[f.status] ?? f.status} <span className="tnum">{fullNumber(Number(f.leads))}</span>
            </button>
          ))}
        </span>

        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {loading ? <span className="mut" style={{ fontSize: 12 }}>Loading…</span> : null}
          <ColumnPicker groups={LEAD_COLUMN_GROUPS} columns={LEAD_COLUMNS} visible={visible} onChange={setVisible} />
        </span>
      </div>

      {/*
        The selection bar. Rendered only when something is selected rather than
        reserving space, so the table does not shift under the cursor as rows
        are ticked.
      */}
      {selected.size > 0 ? (
        <div
          style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "10px 18px",
            background: "var(--blue-pale)", borderBottom: "1px solid var(--line-soft)", fontSize: 13,
          }}
        >
          <span className="tnum" style={{ fontWeight: 600 }}>{fullNumber(selected.size)} selected</span>
          {/*
            Offered only when the filter matches more than the page, and it says
            the real total — the number the removal will actually act on.
          */}
          {total > pageIds.length && selected.size < total ? (
            <button type="button" className="gh" disabled={loadingAll} onClick={() => void selectAllMatching()}>
              {loadingAll ? "Loading…" : `Select all ${fullNumber(total)} matching`}
            </button>
          ) : null}
          <button type="button" className="gh" onClick={() => setSelected(new Set())}>Clear</button>
          {selectError ? <span style={{ color: "var(--red)", fontSize: 12.5 }}>{selectError}</span> : null}
          <span style={{ flex: 1 }} />
          {/*
            Hidden while viewing the Removed facet: those leads are already
            off the campaign, and offering to remove them again would be an
            action that cannot do anything.
          */}
          {viewingRemoved ? (
            <span className="mut" style={{ fontSize: 12.5 }}>Already removed from this campaign</span>
          ) : (
            <Btn style={{ color: "var(--red)" }} onClick={() => setConfirming(true)}>Remove from campaign</Btn>
          )}
        </div>
      ) : null}

      <RemoveLeadsDialog
        campaignId={campaignId}
        campaignName={campaignName}
        platformName={platformName}
        leadIds={[...selected]}
        open={confirming}
        onOpenChange={setConfirming}
        onDone={afterRemoval}
      />

      {error ? (
        <div className="mut" style={{ padding: 34, textAlign: "center" }}>{error}</div>
      ) : !data && loading ? (
        <div className="mut" style={{ padding: 34, textAlign: "center" }}>Loading leads…</div>
      ) : (
        <>
          <div className="tbl-scroll" style={{ opacity: loading ? 0.7 : 1, transition: "opacity .14s" }}>
            <table className="atbl" style={{ minWidth: 780, width: "100%" }}>
              <thead>
                <tr>
                  {/* The identity column stays pinned so a row never loses its
                      person while scrolling sideways. */}
                  <th style={{ position: "sticky", left: 0, zIndex: 2, minWidth: 260, background: "var(--surface)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={allOnPageSelected}
                        onChange={togglePage}
                        aria-label={allOnPageSelected ? "Deselect this page" : "Select this page"}
                        style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                      />
                      Lead
                    </span>
                  </th>
                  {columns.map((c) =>
                    c.sortKey ? (
                      <SortHeader
                        key={c.key}
                        label={c.label}
                        sortKey={c.sortKey}
                        sort={sort}
                        onToggle={toggle}
                        align={(c.align ?? "right") === "right" ? "right" : undefined}
                      />
                    ) : (
                      <th key={c.key} style={{ textAlign: (c.align ?? "right") === "right" ? "right" : "left" }}>
                        {c.label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {total === 0 ? (
                  <EmptyRow colSpan={columns.length + 1}>
                    {debounced || status
                      ? "No leads match that."
                      : "No leads recorded for this campaign yet. Membership is built from the send history, which syncs every three hours."}
                  </EmptyRow>
                ) : (
                  rows.map((row) => {
                    const name = nameOf(row);
                    return (
                      <tr key={String(row.leadId)}>
                        <td style={{ position: "sticky", left: 0, zIndex: 1, minWidth: 260, background: "var(--surface)" }}>
                          <span style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <input
                              type="checkbox"
                              checked={selected.has(row.leadId)}
                              onChange={() => toggleOne(row.leadId)}
                              aria-label={`Select ${row.email ?? row.leadId}`}
                              style={{ accentColor: "var(--blue)", cursor: "pointer", marginTop: 3 }}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {name || row.email || `Lead #${row.leadId}`}
                              </span>
                              {name ? (
                                <span className="mut" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {row.email}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className="tnum"
                            style={{ whiteSpace: "nowrap", textAlign: (c.align ?? "right") === "right" ? "right" : "left" }}
                          >
                            {c.key === "status" ? (
                              <span className={`badge ${STATUS_TONE[row.status] ?? ""}`} style={STATUS_TONE[row.status] ? undefined : { background: "var(--inset)", color: "var(--muted)" }}>
                                {LEAD_STATUS_LABELS[row.status] ?? row.status}
                              </span>
                            ) : (
                              c.render(row as unknown as LeadRow)
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {total > 0 ? (
            <Pager page={page} pageSize={pageSize} total={total} onPage={(next) => setPageState({ key: filterKey, page: next })} />
          ) : null}
        </>
      )}
    </section>
  );
}
