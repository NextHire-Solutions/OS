"use client";

import { useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import {
  CAMPAIGN_INBOXES_URL,
  INBOX_TAGS_URL,
  assignInboxes,
  useAnalyticsData,
  type InboxAssignmentSummary,
} from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Search, Seg } from "./shared";
import { Btn } from "./toast";

/*
 * Assigning a tagged pool of inboxes to the selected campaigns — the tool's
 * `components/campaigns/assign-inboxes-dialog.tsx`.
 *
 * The tags are EmailBison's own — "Nicole Pool", "LeadGenJay", "Zapmail" — read
 * from our cache of every inbox, so choosing a pool costs no API calls and a
 * pool created upstream appears after the next sync-senders.
 */

interface TagRow {
  tag: string;
  inboxes: number;
  connected: number;
}

interface AssignedInbox {
  id: number;
  email: string;
  status: string | null;
  vendor: string | null;
  dailyLimit: number | null;
}

interface Assigned {
  total: number;
  connected: number;
  tags: Array<{ tag: string; inboxes: number }>;
  /** The actual mailboxes on this campaign, broken ones first. */
  inboxes: AssignedInbox[];
}

export function AssignInboxesDialog({
  targets,
  open,
  onOpenChange,
  onDone,
}: {
  /*
   * Platform-qualified. The two platforms assign inboxes by different
   * mechanisms — EmailBison attaches and removes, Instantly replaces the whole
   * `email_list` — and their POOLS are different sets, so a campaign id alone
   * cannot say which pool list to even offer.
   */
  targets: Array<{ platform: "emailbison" | "instantly"; id: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [tag, setTag] = useState<string>("");
  const [action, setAction] = useState<"attach" | "remove">("attach");
  /*
   * A third view, because counts and a list answer different questions. "Nicole
   * Pool 346" tells you the right pool is on the campaign; it does not tell you
   * WHICH mailboxes are sending for it, which is what was actually asked for
   * and the only way to spot a specific broken inbox.
   */
  const [showing, setShowing] = useState<"pools" | "assigned">("pools");
  const [assignedSearch, setAssignedSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<InboxAssignmentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * ONE PLATFORM AT A TIME, because the pools are different sets of inboxes.
   * A mixed selection has no single list of tags to offer — "Nicole Pool" names
   * 428 Instantly accounts and a different EmailBison pool — so the dialog asks
   * for a narrower selection rather than silently assigning whichever pool it
   * happened to load.
   */
  const platforms = [...new Set(targets.map((t) => t.platform))];
  const platform = platforms.length === 1 ? platforms[0] : null;
  const campaignIds = targets.map((t) => t.id);
  const single = campaignIds.length === 1;

  const tagQuery = useAnalyticsData<{ tags: TagRow[] }>(INBOX_TAGS_URL(platform ?? "emailbison"), { skip: !open });

  /*
   * What is ALREADY on the campaign, for the single-campaign case.
   *
   * The count first, separately, because it is one API call against the full
   * answer's forty-five. 0.76s versus 12.6 — so the headline number lands
   * almost at once and the detail catches up. Only fetched for one campaign —
   * across a bulk selection there is no single answer — and only for
   * EmailBison, because the route reads EmailBison's sender list by integer
   * id and refuses a uuid.
   */
  const readable = open && single && platform === "emailbison";
  const quick = useAnalyticsData<{ total: number }>(CAMPAIGN_INBOXES_URL(campaignIds[0] ?? "0", true), { skip: !readable });
  const assignedQuery = useAnalyticsData<Assigned>(CAMPAIGN_INBOXES_URL(campaignIds[0] ?? "0"), { skip: !readable });
  const assigned = readable ? assignedQuery.data : null;
  const assignedLoading = readable && !assigned && assignedQuery.loading;

  const tags = tagQuery.data?.tags ?? [];
  const alreadyOn = new Map((assigned?.tags ?? []).map((t) => [t.tag, t.inboxes]));
  const chosen = tags.find((t) => t.tag === tag);
  // What will actually be sent: an attach skips inboxes that cannot send.
  const willSend = chosen ? (action === "attach" ? chosen.connected : chosen.inboxes) : 0;
  const dead = chosen ? chosen.inboxes - chosen.connected : 0;

  /*
   * How many of this pool are ALREADY on the campaign, and therefore how many
   * would genuinely change. "531 inboxes will start sending" when 346 of them
   * were already sending is true of the end state and false about the change.
   */
  const onAlready = single ? Math.min(alreadyOn.get(tag) ?? 0, willSend) : 0;
  const newlyAdded = Math.max(willSend - onAlready, 0);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setSummary(await assignInboxes(targets, tag, action));
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The assignment failed.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setSummary(null);
      setError(null);
    }, 200);
  };

  const failed = summary?.results.filter((r) => !r.ok) ?? [];
  const headline = assigned?.total ?? quick.data?.total;

  return (
    <DialogFrame
      open={open}
      onClose={running ? () => {} : close}
      width={600}
      title={
        summary
          ? "Assignment finished"
          : `${action === "attach" ? "Assign" : "Remove"} inboxes · ${fullNumber(campaignIds.length)} campaign${campaignIds.length === 1 ? "" : "s"}`
      }
      footer={
        summary ? (
          <Btn primary onClick={close}>Close</Btn>
        ) : (
          <>
            <Btn onClick={close} disabled={running}>Cancel</Btn>
            <Btn
              primary
              onClick={() => void run()}
              disabled={
                running ||
                // A mixed selection has no single pool list, so there is
                // nothing safe to apply.
                !platform ||
                !tag ||
                willSend === 0 ||
                // Nothing would change: every connected inbox in this pool is
                // already on the campaign.
                (action === "attach" && single && platform === "emailbison" && newlyAdded === 0)
              }
            >
              {running ? "Working…" : action === "attach" ? "Assign" : "Remove"}
              {chosen && !running ? ` ${fullNumber(action === "attach" && single && onAlready > 0 ? newlyAdded : willSend)}` : ""}
            </Btn>
          </>
        )
      }
    >
      {/*
        A mixed selection is refused rather than half-served. The two
        platforms' pools are different sets of inboxes, so there is no
        honest single list to offer.
      */}
      {!platform && !summary ? (
        <Warn>This selection spans EmailBison and Instantly, and each has its own inbox pools. Filter to one platform and try again.</Warn>
      ) : null}
      {platform === "instantly" && !summary ? (
        <Panel style={{ background: "var(--inset)", fontSize: 12.5, color: "var(--muted)" }}>
          Instantly replaces a campaign&rsquo;s whole sending list rather than attaching to it, so
          inboxes already assigned are read first and kept.
        </Panel>
      ) : null}

      {summary ? (
        <>
          <p className="tnum" style={{ margin: 0 }}>
            <b>{fullNumber(summary.inboxes)}</b> inboxes tagged <b>{summary.tag}</b>{" "}
            {summary.action === "attach" ? "assigned to" : "removed from"}{" "}
            {fullNumber(summary.results.filter((r) => r.ok).length)} of {fullNumber(summary.results.length)} campaigns.
          </p>
          {summary.skippedDisconnected > 0 ? (
            <p className="tnum mut" style={{ margin: 0, fontSize: 12.5 }}>
              {fullNumber(summary.skippedDisconnected)} tagged {summary.skippedDisconnected === 1 ? "inbox is" : "inboxes are"} not
              connected and {summary.skippedDisconnected === 1 ? "was" : "were"} left out — they cannot send.
            </p>
          ) : null}
          {failed.length ? (
            <Warn>
              <b>{failed.length} did not go through:</b>
              {failed.slice(0, 6).map((r) => (
                <div key={String(r.campaignId)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name} — {r.error}
                </div>
              ))}
            </Warn>
          ) : null}
        </>
      ) : (
        <>
          <Seg
            label="Direction"
            full
            value={action}
            onChange={(next) => {
              setAction(next);
              setShowing("pools");
            }}
            options={[
              { value: "attach", label: "Assign to campaigns" },
              { value: "remove", label: "Remove from campaigns" },
            ]}
          />

          {/*
            Progressive: the count as soon as it exists, the detail when the
            walk finishes. This reads the campaign's inboxes live from
            EmailBison — ~45 pages for a large campaign, several seconds —
            because nothing here stores campaign-to-inbox membership. A bar
            that is present and filling in reads as loading; one that is
            absent reads as finished.
          */}
          {readable && (quick.data || assigned) ? (
            <Panel style={{ background: "var(--inset)", fontSize: 12.5 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="tnum">
                  <b>{fullNumber(headline)}</b> inbox{headline === 1 ? "" : "es"} currently assigned
                  {assigned && assigned.connected !== assigned.total ? (
                    <span style={{ color: "var(--red)" }}> · {fullNumber(assigned.total - assigned.connected)} of them cannot connect</span>
                  ) : null}
                </span>
                {assigned ? (
                  <button type="button" className="gh" onClick={() => setShowing(showing === "assigned" ? "pools" : "assigned")}>
                    {showing === "assigned" ? "Back to pools" : "See which ones"}
                  </button>
                ) : (
                  <span className="mut">loading the list…</span>
                )}
              </div>
              {assigned?.tags.length && showing === "pools" ? (
                <div className="tnum mut" style={{ marginTop: 4 }}>
                  {assigned.tags.slice(0, 4).map((t) => `${t.tag} ${fullNumber(t.inboxes)}`).join(" · ")}
                </div>
              ) : null}
            </Panel>
          ) : readable && assignedLoading ? (
            <Panel style={{ background: "var(--inset)", fontSize: 12.5, color: "var(--muted)" }}>
              Checking which inboxes are already on this campaign…
            </Panel>
          ) : null}

          {/* The mailboxes themselves. */}
          {showing === "assigned" && assigned ? (
            <>
              <Search value={assignedSearch} onChange={setAssignedSearch} placeholder="Search assigned inboxes…" width={300} />
              <div style={{ maxHeight: 288, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-md)" }}>
                {(() => {
                  const q = assignedSearch.trim().toLowerCase();
                  const list = q
                    ? assigned.inboxes.filter(
                        (i) => i.email?.toLowerCase().includes(q) || (i.vendor ?? "").toLowerCase().includes(q),
                      )
                    : assigned.inboxes;
                  if (!list.length) {
                    return <div className="mut" style={{ padding: 24, textAlign: "center", fontSize: 12.5 }}>No assigned inbox matches that.</div>;
                  }
                  return list.map((i) => (
                    <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderTop: "1px solid var(--line-soft)", fontSize: 12.5 }}>
                      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.email}>{i.email}</span>
                      <span className="mut" style={{ flex: "none" }}>{i.vendor ?? "Untagged"}</span>
                      {/* Status shown only when it is NOT the norm — 641 rows
                          reading "Connected" is not information. */}
                      {i.status && i.status !== "Connected" ? (
                        <span className="badge s-risk" style={{ padding: "1px 6px", fontSize: 11 }}>{i.status}</span>
                      ) : null}
                    </div>
                  ));
                })()}
              </div>
            </>
          ) : null}

          {showing === "pools" && tagQuery.loading && !tags.length ? (
            <div className="mut">Loading inbox tags…</div>
          ) : showing === "pools" && tagQuery.error ? (
            <Fail>{tagQuery.error}</Fail>
          ) : showing === "assigned" ? null : (
            <div style={{ maxHeight: 256, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 4 }}>
              {tags.length === 0 ? (
                <div className="mut" style={{ padding: 20, textAlign: "center", fontSize: 12.5 }}>No tagged pools on {platform === "instantly" ? "Instantly" : "EmailBison"}.</div>
              ) : null}
              {tags.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => setTag(t.tag)}
                  aria-pressed={tag === t.tag}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 8px", border: 0, borderRadius: 6,
                    background: tag === t.tag ? "var(--blue-pale)" : "none", cursor: "pointer", font: "inherit", fontSize: 13,
                    fontWeight: tag === t.tag ? 600 : 400, textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.tag}</span>
                  {/* Says how much of this pool is ALREADY on the campaign, so
                      "assign" and "re-assign what is already there" are
                      distinguishable before the click rather than after. */}
                  {assignedLoading ? <span className="mut" style={{ fontSize: 11 }}>…</span> : null}
                  {alreadyOn.has(t.tag) ? (
                    <span className="badge s-done tnum" style={{ padding: "1px 6px", fontSize: 11 }}>{fullNumber(alreadyOn.get(t.tag))} on</span>
                  ) : null}
                  {/* Both numbers: the pool you have, and the part of it that can send. */}
                  <span className="tnum mut" style={{ flex: "none", fontSize: 12 }}>
                    {fullNumber(t.connected)}
                    {t.connected !== t.inboxes ? ` of ${fullNumber(t.inboxes)}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}

          {chosen && showing === "pools" ? (
            <Warn>
              <span className="tnum">
                {action === "attach" ? (
                  <>
                    {single && newlyAdded === 0 && onAlready > 0 ? (
                      // Nothing to do. The attach would succeed and change
                      // nothing, and a button reading "Assign 0" invites a
                      // click that reports success for a no-op.
                      <>All {fullNumber(onAlready)} connected {chosen.tag} inboxes are already on this campaign. Nothing to add.</>
                    ) : single && onAlready > 0 ? (
                      <>
                        <b>{fullNumber(newlyAdded)} {newlyAdded === 1 ? "inbox" : "inboxes"}</b> will start sending.{" "}
                        {fullNumber(onAlready)} of this pool {onAlready === 1 ? "is" : "are"} already on the campaign, so it will
                        hold {fullNumber(willSend)} from {chosen.tag} afterwards.
                      </>
                    ) : (
                      <>
                        <b>{fullNumber(willSend)} inboxes</b> will start sending for {fullNumber(campaignIds.length)} campaign{campaignIds.length === 1 ? "" : "s"}.
                      </>
                    )}
                    {dead > 0 ? <> {fullNumber(dead)} tagged {dead === 1 ? "inbox is" : "inboxes are"} not connected and will be left out.</> : null}
                  </>
                ) : (
                  <>
                    <b>{fullNumber(willSend)} inboxes</b> will stop sending for {fullNumber(campaignIds.length)} campaign{campaignIds.length === 1 ? "" : "s"}.
                    A campaign left with no inboxes cannot send at all.
                  </>
                )}
              </span>
            </Warn>
          ) : null}
        </>
      )}
      {error ? <Fail>{error}</Fail> : null}
    </DialogFrame>
  );
}
