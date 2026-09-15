"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import {
  CAMPAIGN_ACTIONS,
  CAMPAIGN_STATUSES,
  canApply,
  platformSupports,
  whyNot,
  type CampaignAction,
} from "@/lib/tools/analytics/campaigns/status.ts";
import { DASH, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import { shortStamp } from "@/lib/workspace/dates";
import {
  CAMPAIGNS_URL,
  applyCampaignAction,
  describeSync,
  runSync,
  useAnalyticsData,
  type ActionResult,
} from "./actions";
import { AssignInboxesDialog } from "./assign-inboxes-dialog";
import { ReCampaignDialog } from "./re-campaign-dialog";
import { Bar, Box, EmptyRow, LoadError, Pager, Search, Seg, SortHeader, sortRows, useDebounced, useSort } from "./shared";
import { StalenessStrip } from "./staleness-strip";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — Campaigns.
 *
 * The tool's `/campaigns`: every campaign on both platforms, and the four
 * things you can do to one. This is the only Analytics screen that reaches
 * OUTSIDE the database — pause, resume, archive and duplicate are calls to
 * EmailBison and Instantly, and the local `status` column is written only after
 * the platform has said yes.
 *
 * Two rules are load-bearing and both come from `campaigns/status.ts`, imported
 * rather than restated so the button and the server can never disagree:
 *
 *   `canApply`        — is this campaign in a state where the action makes
 *                       sense. RESUME IS OFFERED ONLY FOR `paused`, because
 *                       resume does not restore a previous status: it queues
 *                       the campaign to send. On a completed campaign the word
 *                       reads as "un-hide this" and the effect is "start
 *                       emailing everyone still attached to it".
 *   `platformSupports`— does the platform have the action at all. Instantly has
 *                       no archive; offering it would write a local flag while
 *                       changing nothing upstream.
 *
 * Resume is the one action that starts sending, so it is armed twice and the
 * armed caption names the lead count. The tool uses `window.confirm`, which
 * suspends the page and cannot be driven by a test.
 *
 * Two ways in to the same four actions, as in the tool: the bulk bar over a
 * selection, and a per-row menu (`RowMenu`) that names WHY an action is
 * unavailable rather than merely greying it out. Both read the same two rules.
 */

const ACTION_LABEL: Record<CampaignAction, string> = {
  pause: "Pause",
  resume: "Resume",
  archive: "Archive",
  duplicate: "Duplicate",
};

/** The tool's menu order — resume beside pause, archive last. */
const MENU_ORDER: readonly CampaignAction[] = ["pause", "resume", "duplicate", "archive"];

/**
 * Why this action is unavailable on this campaign, for the disabled item's
 * tooltip. Status first, then platform: `whyNot` answers the status question
 * and has nothing to say about Instantly's missing archive.
 */
function unavailableReason(action: CampaignAction, c: Campaign): string {
  if (!canApply(action, c.status)) return whyNot(action, c.status);
  if (!platformSupports(action, c.platform)) {
    return "Instantly has no archive — it would set a local flag and change nothing upstream";
  }
  return "";
}

interface Campaign {
  id: string;
  platform: "emailbison" | "instantly";
  name: string;
  status: string;
  tags: unknown[];
  lifetime_unique_replies: number | null;
  completion_percentage: number | null;
  total_leads: number | null;
  lifetime_emails_sent: number | null;
  max_emails_per_day: number | null;
  eb_updated_at: string | null;
  updated_at?: string | null;
  clientName: string | null;
  clientId?: string | null;
  excluded: boolean;
  ambiguous?: boolean;
}

interface ListResponse {
  items: Campaign[];
  total: number;
  statusCounts: Record<string, number>;
  platformCounts?: Record<string, number>;
  all: number;
  clients: Array<{ id: string; name: string }>;
  tags?: string[];
}

const PAGE_SIZE = 200;

const STATUS_TONE: Record<string, string> = {
  draft: "plan-min",
  launching: "plan-prod",
  queued: "plan-prod",
  active: "s-done",
  paused: "s-ok",
  completed: "plan-min",
  archived: "plan-min",
};

function StatusChip({ status }: { status: string }) {
  const known = (CAMPAIGN_STATUSES as readonly string[]).includes(status);
  // An unknown status is drift — something upstream changed and nothing here
  // knows about it. Red, deliberately, rather than a neutral chip.
  return (
    <span className={known ? `badge ${STATUS_TONE[status] ?? "plan-min"}` : "badge s-risk"}>
      {status}
    </span>
  );
}

export function AnalyticsCampaignsScreen({ onOpen }: { onOpen?: (id: string) => void }) {
  const [status, setStatus] = useState("all");
  const [rawQ, setRawQ] = useState("");
  const q = useDebounced(rawQ);
  const [platform, setPlatform] = useState("");
  const [clientId, setClientId] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ action: string; applied: number; results: ActionResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [assigningInboxes, setAssigningInboxes] = useState(false);
  const [reCampaigning, setReCampaigning] = useState(false);
  const { toast, show } = useToast();
  const { sort, toggle } = useSort();

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("status", status);
    if (q.trim()) p.set("q", q.trim());
    if (platform) p.set("platforms", platform);
    if (clientId) p.set("client_id", clientId);
    if (tag) p.set("tag", tag);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String((page - 1) * PAGE_SIZE));
    return p.toString();
  }, [status, q, platform, clientId, tag, page]);

  const { data, error, loading, reload } = useAnalyticsData<ListResponse>(CAMPAIGNS_URL(qs));

  const rows = useMemo(
    () =>
      sortRows(data?.items ?? [], sort, (r, key) => {
        if (key === "replyRate") {
          return r.lifetime_emails_sent && r.lifetime_unique_replies
            ? r.lifetime_unique_replies / r.lifetime_emails_sent
            : null;
        }
        return (r as unknown as Record<string, number | string | null>)[key];
      }),
    [data, sort],
  );

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  /*
   * Re-campaign is EmailBison only — its route addresses the source by integer
   * id. A mixed selection is told how many of its campaigns the action
   * actually reaches, rather than being refused or silently narrowed.
   */
  const emailBisonSelection = chosen.filter((c) => c.platform === "emailbison");
  const selectionHasInstantly = chosen.some((c) => c.platform === "instantly");
  const dialogsNeedEmailBison = selectionHasInstantly && emailBisonSelection.length > 0;
  const eligible = (action: CampaignAction) =>
    chosen.filter((c) => platformSupports(action, c.platform) && canApply(action, c.status));

  /**
   * Applies one action to the given campaigns — the bulk bar hands in the
   * eligible slice of the selection, the row menu hands in one campaign.
   */
  async function apply(action: CampaignAction, targets: Campaign[]) {
    if (!targets.length) return;
    setBusy(true);
    try {
      const outcome = await applyCampaignAction(
        action,
        targets.map((c) => ({ platform: c.platform, id: c.id })),
      );
      await reload();
      setSelected(new Set());
      setResult({
        action,
        applied: outcome.applied ?? 0,
        results: outcome.results ?? [],
      });
      show({
        text: `${action}: ${outcome.applied ?? 0} of ${targets.length} applied`,
        bad: (outcome.failed ?? 0) > 0,
      });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "The action failed", bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <LoadError what="Campaigns" error={error} />;

  const counts = data?.statusCounts ?? {};
  const resumeLeads = eligible("resume").reduce((t, c) => t + (c.total_leads ?? 0), 0);

  return (
    <div className="an-screen">
    <StalenessStrip />
    <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>Campaigns</div>
          <div className="tbl-sub">
            {data ? `${fullNumber(data.total)} matching · ${fullNumber(data.all)} in the workspace` : "Loading…"}
          </div>
        </div>
        <Btn
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const outcome = await runSync("sync-entities");
              await reload();
              show(describeSync("Campaigns", outcome));
            } catch (e) {
              show({ text: e instanceof Error ? e.message : "Sync failed", bad: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Sync campaigns
        </Btn>
      </div>

      <div className="an-filter" style={{ borderRadius: "var(--r-md)", border: "1px solid var(--line)", marginBottom: 18 }}>
        <div className="qr" role="group" aria-label="Status">
          {["all", "active", "paused"].map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? "on" : ""}
              aria-pressed={status === s}
              onClick={() => { setStatus(s); setPage(1); }}
            >
              {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
              <span className="mut" style={{ marginLeft: 5 }}>
                {s === "all" ? data?.all ?? "" : counts[s] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <select
          className="sel"
          aria-label="Other statuses"
          value={["all", "active", "paused"].includes(status) ? "" : status}
          onChange={(e) => { setStatus(e.target.value || "all"); setPage(1); }}
        >
          <option value="">More statuses…</option>
          {CAMPAIGN_STATUSES.filter((s) => !["active", "paused"].includes(s)).map((s) => (
            <option key={s} value={s}>{s} ({counts[s] ?? 0})</option>
          ))}
        </select>
        <Search value={rawQ} onChange={(v) => { setRawQ(v); setPage(1); }} placeholder="Search campaigns…" />
        <select
          className="sel"
          aria-label="Platform"
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value);
            setPage(1);
            // Clearing the selection: the rows about to be listed are not the
            // rows that were ticked, and a bulk action on invisible campaigns
            // is exactly the mistake this screen must not allow.
            setSelected(new Set());
          }}
        >
          <option value="">All platforms</option>
          <option value="emailbison">EmailBison {data?.platformCounts?.emailbison ? `(${data.platformCounts.emailbison})` : ""}</option>
          <option value="instantly">Instantly {data?.platformCounts?.instantly ? `(${data.platformCounts.instantly})` : ""}</option>
        </select>
        <ClientPicker
          clients={data?.clients ?? []}
          value={clientId}
          onChange={(next) => { setClientId(next); setPage(1); }}
        />
        {data?.tags?.length ? (
          <select className="sel" aria-label="Tag" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
            <option value="">Any tag</option>
            {data.tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : null}
        <span style={{ flex: 1 }} />
        <Seg
          label="Layout"
          value={view}
          options={[
            { value: "list", label: "List" },
            { value: "grid", label: "Grid" },
          ]}
          onChange={setView}
        />
      </div>

      {selected.size > 0 ? (
        <div className="mi-selbar" style={{ borderRadius: "var(--r-md)", marginBottom: 16, border: "1px solid var(--line)" }}>
          <b style={{ color: "var(--ink)" }}>{selected.size} selected</b>
          {new Set(chosen.map((c) => c.platform)).size > 1 ? (
            <span>mixed platforms — each action applies only where the platform supports it</span>
          ) : null}
          {dialogsNeedEmailBison ? (
            <span className="mut" style={{ fontSize: 12 }}>
              · Re-campaign applies to the {emailBisonSelection.length} EmailBison campaign
              {emailBisonSelection.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {CAMPAIGN_ACTIONS.map((action) => {
            const n = eligible(action).length;
            if (action === "resume") {
              return (
                <ConfirmButton
                  key={action}
                  primary
                  label={`Resume (${n})`}
                  armedLabel={
                    resumeLeads > 0
                      ? `Send to ${fullNumber(resumeLeads)} people?`
                      : `Confirm resume (${n})`
                  }
                  title={`Resume queues these campaigns to SEND. It does not restore a previous status. ${
                    resumeLeads > 0 ? `${fullNumber(resumeLeads)} leads are still attached.` : ""
                  }`}
                  disabled={busy || n === 0}
                  onConfirm={() => void apply(action, eligible(action))}
                />
              );
            }
            return (
              <Btn
                key={action}
                disabled={busy || n === 0}
                title={n === 0 && chosen.length ? whyNot(action, chosen[0].status) : undefined}
                onClick={() => void apply(action, eligible(action))}
              >
                {action[0].toUpperCase() + action.slice(1)} ({n})
              </Btn>
            );
          })}
          {/*
            Separated from the status actions because it is a different kind of
            change: pause/resume/archive move a campaign through its lifecycle,
            this one decides which mailboxes send for it. It also has no
            eligibility rule — any campaign can be given inboxes.
          */}
          <Btn disabled={busy || selected.size === 0} onClick={() => setAssigningInboxes(true)}>
            Inboxes
          </Btn>
          {/*
            Client feedback: re-campaign was reachable only from a campaign's
            own Sequence tab. It builds ONE new campaign from ONE source, so it
            is offered only when a single campaign is selected — a bulk version
            would have to invent a name per campaign and would create as many
            drafts as were ticked, which is not what ticking implies.
          */}
          <Btn
            disabled={busy || selected.size !== 1 || emailBisonSelection.length !== 1}
            title={
              selected.size !== 1
                ? "Select exactly one campaign to re-campaign it"
                : emailBisonSelection.length !== 1
                  ? "Re-campaign is EmailBison only. On Instantly it would have to MOVE the leads — emptying the source campaign — because the workspace is over its lead limit and leads cannot be copied."
                  : undefined
            }
            onClick={() => setReCampaigning(true)}
          >
            Re-campaign
          </Btn>
          <Btn onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      ) : null}

      {/*
        Both platforms. The dialog handles ONE platform at a time because the
        pools are different sets of inboxes — "Nicole Pool" names 428 Instantly
        accounts and a separate EmailBison pool — so it asks for a narrower
        selection rather than assigning whichever list it loaded.
      */}
      <AssignInboxesDialog
        targets={chosen.map((c) => ({ platform: c.platform, id: c.id }))}
        open={assigningInboxes}
        onOpenChange={setAssigningInboxes}
        onDone={() => setSelected(new Set())}
      />

      {/* Mounted only with a single selection, so the dialog can never be
          handed an ambiguous source campaign. */}
      {chosen.length === 1 && chosen[0].platform === "emailbison" ? (
        <ReCampaignDialog
          campaignId={chosen[0].id}
          campaignName={chosen[0].name}
          open={reCampaigning}
          onOpenChange={setReCampaigning}
          onCreated={() => void reload()}
        />
      ) : null}

      {result ? (
        <Box
          title={`${result.action}: ${result.applied} of ${result.results.length} applied`}
          right={<Btn onClick={() => setResult(null)}>Dismiss</Btn>}
        >
          <div style={{ padding: 18, maxHeight: 260, overflowY: "auto" }}>
            {result.results
              .slice()
              .sort((a, b) => Number(Boolean(a.ok)) - Number(Boolean(b.ok)))
              .map((r, i) => (
                <div key={i} style={{ padding: "6px 0", fontSize: 13, borderTop: i ? "1px solid var(--line-soft)" : undefined }}>
                  <span className={`badge ${r.ok ? "s-done" : "s-risk"}`} style={{ marginRight: 9 }}>
                    {r.ok ? "ok" : "failed"}
                  </span>
                  {r.name ?? r.campaignId ?? r.id}
                  {r.error ? <span style={{ color: "var(--red)" }}> — {r.error}</span> : null}
                </div>
              ))}
          </div>
        </Box>
      ) : null}

      <Box title="Every campaign" note="Both platforms, in one list.">
        {view === "grid" ? (
          <CampaignGrid
            rows={rows}
            loaded={Boolean(data)}
            query={q}
            selected={selected}
            setSelected={setSelected}
            busy={busy}
            onAction={(action, c) => void apply(action, [c])}
          />
        ) : (
        <div className="tbl-scroll">
          <table className="atbl" style={{ minWidth: 1160 }}>
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    aria-label="Select every campaign on this page"
                    checked={rows.length > 0 && selected.size === rows.length}
                    style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                  />
                </th>
                <SortHeader label="Campaign" sortKey="name" sort={sort} onToggle={toggle} width={340} />
                <th style={{ width: 170 }}>Client</th>
                <th style={{ width: 110 }}>Status</th>
                <SortHeader label="Sent" sortKey="lifetime_emails_sent" sort={sort} onToggle={toggle} align="right" />
                <SortHeader label="Replies" sortKey="lifetime_unique_replies" sort={sort} onToggle={toggle} align="right" />
                <SortHeader label="Leads" sortKey="total_leads" sort={sort} onToggle={toggle} align="right" />
                <SortHeader label="Progress" sortKey="completion_percentage" sort={sort} onToggle={toggle} width={150} />
                <th style={{ width: 100 }}>Updated</th>
                <th style={{ width: 44 }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={10}>
                  {data ? (q.trim() ? `No campaigns match “${q.trim()}”` : "No campaigns found") : "Loading…"}
                </EmptyRow>
              ) : (
                rows.map((c) => {
                  const rate =
                    c.lifetime_emails_sent && c.lifetime_unique_replies
                      ? c.lifetime_unique_replies / c.lifetime_emails_sent
                      : null;
                  return (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.name}`}
                          checked={selected.has(c.id)}
                          style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                          onChange={(e) =>
                            setSelected((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(c.id);
                              else next.delete(c.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        {/*
                          A LINK, not a button with a callback.
                          -----------------------------------------------------
                          This was `onClick={() => onOpen?.(c.id)}` with
                          `disabled={!onOpen}`, and the screen is mounted from a
                          SERVER component (app/[[...slug]]/page.tsx), which
                          cannot pass a function to a client component. So
                          `onOpen` was always undefined, every campaign name
                          rendered as a disabled button, and all 502 campaigns
                          were unreachable — while `/analytics/campaigns/<id>`
                          existed and worked the whole time.

                          A link needs nothing passed in, and it also restores
                          what a button silently took away: middle-click, open
                          in a new tab, copy link, and prefetch on hover.

                          prefetch={false}: hover-only. With the default, every row
                          prefetched its detail page as it scrolled into view — five
                          to seven server renders per screen, measured competing with
                          the list's own request on production.
                        */}
                        <Link
                          href={`/analytics/campaigns/${c.id}`}
                          prefetch={false}
                          onClick={onOpen ? (e) => { e.preventDefault(); onOpen(c.id); } : undefined}
                          title={c.name}
                          style={{
                            font: "inherit", textAlign: "left", cursor: "pointer",
                            color: "var(--blue)", fontWeight: 600, textDecoration: "none",
                            maxWidth: 330, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            display: "block",
                          }}
                        >
                          {c.name}
                        </Link>
                        {c.platform === "instantly" ? <span className="c c-bison">Instantly</span> : null}
                      </td>
                      <td>
                        {c.excluded ? (
                          <span className="mut" style={{ fontStyle: "italic" }}>excluded</span>
                        ) : (
                          c.clientName ?? <span className="mut">Unassigned</span>
                        )}
                      </td>
                      <td><StatusChip status={c.status} /></td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(c.lifetime_emails_sent)}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {fullNumber(c.lifetime_unique_replies)}
                        {rate != null ? <span className="cpct"> {percent(rate, 2)}</span> : null}
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(c.total_leads)}</td>
                      <td>
                        {c.completion_percentage == null ? (
                          // A dash, never an empty track — an empty bar reads
                          // as "0% done", which is a different claim.
                          <span className="mut">{DASH}</span>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ flex: 1 }}>
                              <Bar fraction={c.completion_percentage / 100} color="var(--blue)" />
                            </span>
                            <span className="tnum mut" style={{ fontSize: 12 }}>
                              {Math.round(c.completion_percentage)}%
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="mut" style={{ fontSize: 12.5 }}>
                        {shortStamp(c.eb_updated_at ?? c.updated_at ?? null, Date.now())}
                      </td>
                      <td>
                        <RowMenu campaign={c} busy={busy} onAction={(action) => void apply(action, [c])} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        )}
        {data ? <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} /> : null}
      </Box>
      <Toast toast={toast} />
    </div>
    </div>
  );
}

/* --------------------------- the client filter ----------------------------- */

/*
 * The client filter, searchable — the tool's `components/campaigns/client-picker.tsx`.
 *
 * It was a <select> of fifty clients, which the browser renders as a scroll
 * and nothing else — finding "Norvell&Co" meant reading the list. This is the
 * same behaviour in the workspace's own controls: a `.gh` trigger and a
 * portalled, searchable panel (see ui/anchored-panel.tsx).
 *
 * SINGLE SELECT, matching what the route accepts: `client_id` takes one
 * value, and pretending otherwise in the UI would let someone choose three
 * clients and see one.
 *
 * The three special choices sit above the roster because they are not
 * clients: everything, no client, and the campaigns deliberately kept out of
 * client reporting. Without the last one, seventeen campaigns are reachable
 * by no choice at all.
 */
const CLIENT_SPECIAL: Array<{ id: string; name: string }> = [
  { id: "", name: "All clients" },
  { id: "unassigned", name: "Unassigned" },
  { id: "excluded", name: "Excluded from reporting" },
];

function ClientPicker({
  clients,
  value,
  onChange,
}: {
  clients: Array<{ id: string; name: string }>;
  /** "" = all · "unassigned" · "excluded" · a client id */
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const label =
    CLIENT_SPECIAL.find((s) => s.id === value)?.name ??
    clients.find((c) => c.id === value)?.name ??
    "All clients";

  const needle = q.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const special = CLIENT_SPECIAL.filter((s) => matches(s.name));
  const shown = clients.filter((c) => matches(c.name));

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const row = (id: string, name: string, key: string) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={value === id}
      onClick={() => choose(id)}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
        border: 0, background: value === id ? "var(--blue-pale)" : "none", padding: "7px 10px",
        borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 12.5, color: "var(--ink-2)",
      }}
    >
      <span aria-hidden style={{ width: 12, flex: "none" }}>{value === id ? "✓" : ""}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </button>
  );

  return (
    <span style={{ position: "relative", flex: "none" }}>
      <button
        ref={trigger}
        type="button"
        className="gh"
        aria-label="Filter by client"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          maxWidth: 200, display: "inline-flex", alignItems: "center", gap: 6,
          ...(value ? { borderColor: "var(--blue)", color: "var(--blue-ink)" } : null),
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span aria-hidden className="mut">▾</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={288} label="Filter by client">
        <div style={{ padding: 8, borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
          <input
            className="inp"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clients…"
            aria-label="Search clients"
            style={{ width: "100%", minWidth: 0 }}
          />
        </div>
        <div role="listbox" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 4 }}>
          {special.length === 0 && shown.length === 0 ? (
            <div className="mut" style={{ padding: 20, textAlign: "center", fontSize: 12.5 }}>No client matches that.</div>
          ) : (
            <>
              {special.map((s) => row(s.id, s.name, s.id || "all"))}
              {shown.length ? (
                <>
                  <div className="csince" style={{ padding: "8px 10px 4px" }}>Clients</div>
                  {shown.map((c) => row(c.id, c.name, c.id))}
                </>
              ) : null}
            </>
          )}
        </div>
      </AnchoredPanel>
    </span>
  );
}

/* ------------------------------ the grid ---------------------------------- */

/**
 * The same rows as cards — the tool's `view === "grid"` branch: checkbox,
 * name, the row menu, status beside client, then sent / leads / updated.
 */
function CampaignGrid({
  rows,
  loaded,
  query,
  selected,
  setSelected,
  busy,
  onAction,
}: {
  rows: Campaign[];
  loaded: boolean;
  query: string;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  busy: boolean;
  onAction: (action: CampaignAction, campaign: Campaign) => void;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
        {loaded ? (query.trim() ? `No campaigns match “${query.trim()}”` : "No campaigns found") : "Loading…"}
      </div>
    );
  }
  return (
    <div
      className="grid2"
      style={{ padding: 18, gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
    >
      {rows.map((c) => {
        const on = selected.has(c.id);
        return (
          <div
            key={c.id}
            style={{
              display: "flex", flexDirection: "column", gap: 8, padding: 14,
              border: `1px solid ${on ? "var(--blue)" : "var(--line)"}`,
              borderRadius: "var(--r-md)", background: "var(--surface)",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                aria-label={`Select ${c.name}`}
                checked={on}
                style={{ accentColor: "var(--blue)", cursor: "pointer", marginTop: 3 }}
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  })
                }
              />
              <Link
                href={`/analytics/campaigns/${c.id}`}
                prefetch={false}
                title={c.name}
                style={{
                  flex: 1, minWidth: 0, color: "var(--blue)", fontWeight: 600, fontSize: 13.5,
                  lineHeight: 1.35, textDecoration: "none",
                }}
              >
                {c.name}
              </Link>
              <RowMenu campaign={c} busy={busy} onAction={(action) => onAction(action, c)} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
              <StatusChip status={c.status} />
              {c.platform === "instantly" ? <span className="c c-bison">Instantly</span> : null}
              <span
                className="mut"
                style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {c.excluded ? "excluded" : c.clientName ?? "Unassigned"}
              </span>
            </div>
            <div className="tnum mut" style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
              <span>{fullNumber(c.lifetime_emails_sent)} sent</span>
              <span>{fullNumber(c.total_leads)} leads</span>
              <span style={{ marginLeft: "auto" }}>
                {shortStamp(c.eb_updated_at ?? c.updated_at ?? null, Date.now())}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- the row menu -------------------------------- */

/**
 * The four actions for ONE campaign — the tool's `RowMenu`.
 *
 * Disabled items keep their reason rather than just greying out, so "why can't
 * I resume this?" is answered in place. Resume is the tool's confirm dialog
 * collapsed into the workspace's armed button: the first click names the lead
 * count, the second sends.
 */
function RowMenu({
  campaign,
  busy,
  onAction,
}: {
  campaign: Campaign;
  busy: boolean;
  onAction: (action: CampaignAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const leads = campaign.total_leads ?? 0;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={trigger}
        type="button"
        className="gh"
        aria-label={`Actions for ${campaign.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ padding: "3px 9px", fontWeight: 700, letterSpacing: ".08em", lineHeight: 1.2 }}
      >
        ···
      </button>
      {/* Portalled: this menu sits in a `.tbl-scroll`, which clips. */}
      <AnchoredPanel
        anchorRef={trigger}
        open={open}
        onClose={close}
        width={250}
        align="end"
        label={`Actions for ${campaign.name}`}
      >
        <div role="menu" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {MENU_ORDER.map((action) => {
            const reason = unavailableReason(action, campaign);
            const allowed = reason === "";
            if (action === "resume") {
              return (
                <ConfirmButton
                  key={action}
                  primary
                  label={ACTION_LABEL[action]}
                  armedLabel={leads > 0 ? `Send to ${fullNumber(leads)} people?` : "Confirm resume"}
                  title={
                    allowed
                      ? `Resume queues this campaign to SEND. It does not restore a previous status.${
                          leads > 0 ? ` ${fullNumber(leads)} leads are still attached.` : ""
                        }`
                      : reason
                  }
                  disabled={busy || !allowed}
                  onConfirm={() => { close(); onAction(action); }}
                />
              );
            }
            return (
              <Btn
                key={action}
                role="menuitem"
                disabled={busy || !allowed}
                title={allowed ? undefined : reason}
                style={{ textAlign: "left" }}
                onClick={() => { close(); onAction(action); }}
              >
                {ACTION_LABEL[action]}
              </Btn>
            );
          })}
        </div>
      </AnchoredPanel>
    </span>
  );
}
