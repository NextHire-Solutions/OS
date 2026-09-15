"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  COPY_DIMENSIONS,
  MEDAL_MIN_SENT,
  awardMedals,
  type CopyDimensionKey,
} from "@/lib/tools/analytics/copy-dimensions.ts";
import { DASH, fullNumber, percent, rangeLabel } from "@/lib/tools/analytics/format.ts";
import {
  CAMPAIGN_URL,
  COPY_URL,
  OFFERS_URL,
  OFFER_SUGGESTIONS_URL,
  createOffer,
  describeSync,
  planCopySequence,
  removeOffer,
  runSync,
  suggestCopyTags,
  updateOffer,
  useAnalyticsData,
  type CopyMode,
  type CopyPlan,
} from "./actions";
import { BulkDeployPanel, useBulkDeploy, type DeployBatch } from "./bulk-deploy";
import { useCampaignOptions } from "./copy-sequence-dialog";
import { DialogFrame, Panel } from "./dialog-frame";
import { CampaignMultiPicker } from "./push-sequence-dialog";
import { AnalyticsFilters, FilterBar, todayInET, useAnalyticsFilters } from "./filters";
import {
  AnalyticsTabs,
  Box,
  EmptyRow,
  LoadError,
  Search,
  SortHeader,
  sortRows,
  useSort,
} from "./shared";
import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — Copy & Offer.
 *
 * The tool's `/analytics/copy-offer`: which words work, and which offers work.
 * It is the only analytics tab that writes, and both of its writes are here —
 * creating and editing an offer, and seeding subject-line tags.
 *
 * Three of the tool's own defects are corrected rather than reproduced, each
 * recorded in ANALYTICS-PARITY.md:
 *
 *   · the expanded row's `colSpan` is one column short of the table it sits in
 *     (`dimensions.length + 7` against `+ 8`), so the payoff of the whole screen
 *     renders misaligned;
 *   · the footnote claims "Variants of the first email are included" while
 *     `analytics_copy_steps` ends `AND NOT st.is_variant`;
 *   · "Suggest subject types" renders only when coverage is exactly zero, so it
 *     disappears at 3% — with hundreds of first emails still untagged — which is
 *     precisely when it is still worth pressing.
 */

interface Member {
  id: number;
  subject: string | null;
  campaign: string | null;
  sent: number;
  replies: number;
  positive: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface CopyRow {
  key: string;
  values: string[];
  members: Member[];
  steps: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  meetings: number;
  untagged: boolean;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface SpintaxRow {
  campaign_id: number | string;
  campaign_name: string;
  client_name: string | null;
  steps: number;
  spun_steps: number;
  variants: number;
  status: "spintax" | "partial" | "variants" | "none" | "unknown";
  sent: number;
  platform?: string;
}

interface CopyResponse {
  dimensions: string[];
  from: string;
  to: string;
  rows: CopyRow[];
  coverage: { tagged_sent: number; total_sent: number; tagged_steps: number; total_steps: number };
  spintax: SpintaxRow[];
}

interface OfferRow {
  offer_id: string;
  offer_name: string;
  niche: string | null;
  campaigns: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
  source: { source_campaign_id: number; source_name: string; step_count: number } | null;
  clients?: Array<{ client: string; campaigns: number; sent: number; replies: number; positive: number }>;
}

interface Suggestion {
  fingerprint: string;
  example_subject: string;
  variants: number;
  campaigns: number;
  campaign_ids: number[];
  source_campaign_id: number;
  source_name: string;
  step_count: number;
  claimed: number;
  sent: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

export function AnalyticsCopyScreen() {
  const [today] = useState(todayInET);
  return (
    <AnalyticsFilters today={today}>
      <CopyBody />
    </AnalyticsFilters>
  );
}

function CopyBody() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();
  const [dimensions, setDimensions] = useState<CopyDimensionKey[]>(["subject_line"]);
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);

  const copy = useAnalyticsData<CopyResponse>(COPY_URL(`${qs}&dimensions=${dimensions.join(",")}`));
  const offers = useAnalyticsData<{ rows: OfferRow[] }>(OFFERS_URL(qs));
  const suggestions = useAnalyticsData<{ suggestions: Suggestion[] }>(OFFER_SUGGESTIONS_URL(qs));

  /*
   * One-click deploy from an offer card — the tool's `useBulkDeploy()` in
   * `CopyOfferView`. Its settle hook is the tool's
   * `invalidateQueries(["offers"])`: the offer's campaign count and step count
   * are what a copy changes.
   */
  const offersReload = offers.reload;
  const reloadOffers = useCallback(() => void offersReload(), [offersReload]);
  const deploy = useBulkDeploy(reloadOffers);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([copy.reload(), offers.reload(), suggestions.reload()]);
      show({ text: what });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  };

  /** The sync, reported with what it wrote — see describeSync. */
  const sync = async () => {
    setBusy(true);
    try {
      const outcome = await runSync("sync-entities");
      await Promise.all([copy.reload(), offers.reload(), suggestions.reload()]);
      show(describeSync("Campaigns", outcome));
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  };

  if (copy.error) return <LoadError what="Copy performance" error={copy.error} />;

  return (
    <div className="an-screen">
      <AnalyticsTabs active="copy" />
      <FilterBar tab="copy" />
      <div className="wrap">
        {/* The progress panel sits above everything and stays put while the
            batch runs, so a failure is never scrolled out of view. */}
        <BulkDeployPanel
          batch={deploy.batch}
          running={deploy.running}
          onRetry={deploy.retryFailed}
          onDismiss={deploy.dismiss}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tbl-title" style={{ fontSize: 19 }}>Copy &amp; Offer</div>
            <div className="tbl-sub">Which words work, and which offers work.</div>
          </div>
          <Btn disabled={busy} onClick={() => void sync()}>
            Sync campaigns
          </Btn>
        </div>

        <Offers
          rows={offers.data?.rows ?? []}
          busy={busy}
          onRun={run}
          onDeploy={deploy.start}
          loading={offers.loading}
        />

        <Suggestions
          suggestions={suggestions.data?.suggestions ?? []}
          busy={busy}
          onRun={run}
        />

        <Spintax spintax={copy.data?.spintax ?? []} />

        <CopyTable
          data={copy.data}
          dimensions={dimensions}
          setDimensions={setDimensions}
          busy={busy}
          onRun={run}
          loading={copy.loading}
        />
      </div>
      <Toast toast={toast} />
    </div>
  );
}

/* -------------------------------- offers ---------------------------------- */

function Offers({
  rows,
  busy,
  onRun,
  onDeploy,
  loading,
}: {
  rows: OfferRow[];
  busy: boolean;
  onRun: (what: string, fn: () => Promise<unknown>) => Promise<void>;
  /** The tool's `deploy.start` — hands a checked batch to the bulk runner. */
  onDeploy: (batch: DeployBatch) => void;
  loading: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OfferRow | null>(null);
  const [deploying, setDeploying] = useState<OfferRow | null>(null);

  return (
    <Box
      title="Offers"
      note="An offer is a thing in its own right — Zillow Flex, realtor.com VIP — not just a campaign name."
      right={<Btn primary disabled={busy} onClick={() => setCreating(true)}>Add offer</Btn>}
      style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
    >
      {creating ? (
        <OfferForm
          title="New offer"
          busy={busy}
          sourceHint="This campaign's sequence becomes the offer's, and is what gets copied to other campaigns."
          onCancel={() => setCreating(false)}
          onSave={async (name, niche, sourceCampaignId) => {
            // As the tool's CreateOfferDialog sends it: the source campaign is
            // also attached, so a new offer is never an empty group.
            await onRun(`Added “${name}”`, () =>
              createOffer(name, niche, sourceCampaignId ?? undefined, sourceCampaignId ? [sourceCampaignId] : []),
            );
            setCreating(false);
          }}
        />
      ) : null}

      <div
        className="grid2"
        style={{ padding: 22, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
      >
        {rows.length === 0 && !creating ? (
          <div className="mut">No offers yet. Add one, or create one from a suggestion below.</div>
        ) : null}
        {rows.map((o) =>
          editing?.offer_id === o.offer_id ? (
            <div key={o.offer_id} style={{ border: "1px solid var(--blue)", borderRadius: "var(--r-md)", minWidth: 0 }}>
              <OfferForm
                title={`Edit “${o.offer_name}”`}
                initialName={o.offer_name}
                initialNiche={o.niche ?? ""}
                initialSourceId={o.source?.source_campaign_id ?? null}
                sourceEmptyLabel="Highest-volume campaign (automatic)"
                sourceHint="Campaigns in an offer drift apart as they are edited, so this picks which version gets copied. Left automatic, it follows the highest-volume one."
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={async (name, niche, sourceCampaignId) => {
                  await onRun(`Saved “${name}”`, () =>
                    updateOffer(o.offer_id, { name, niche, sourceCampaignId }),
                  );
                  setEditing(null);
                }}
                onDelete={async () => {
                  await onRun(`Deleted “${o.offer_name}”`, () => removeOffer(o.offer_id));
                  setEditing(null);
                }}
                deleteTitle={`Delete “${o.offer_name}”? Its ${o.campaigns} campaign${o.campaigns === 1 ? " is" : "s are"} only detached — none of them is changed or deleted.`}
              />
            </div>
          ) : (
            // `minWidth: 0` — a grid item's default `min-width: auto` lets a
            // nowrap child widen the card past its track, and every ellipsis
            // inside then has nothing to truncate against.
            <div key={o.offer_id} style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 16, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cname">{o.offer_name}</div>
                  <div className="csince">
                    {o.niche ?? "No niche set"} · {o.campaigns} campaign{o.campaigns === 1 ? "" : "s"}
                  </div>
                </div>
                <Btn disabled={busy} onClick={() => setEditing(o)} aria-label={`Edit ${o.offer_name}`}>
                  Edit
                </Btn>
              </div>
              {o.source ? (
                <SequenceLink
                  campaignId={o.source.source_campaign_id}
                  campaignName={o.source.source_name}
                  stepCount={o.source.step_count}
                />
              ) : (
                <div className="cmeta" style={{ marginTop: 10 }}>
                  No campaign attached yet — nothing to copy from.
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 14 }}>
                {[
                  ["Sent", fullNumber(o.sent)],
                  ["Reply %", percent(o.reply_rate, 2)],
                  ["Positive %", percent(o.positive_rate, 2)],
                  ["Bounce %", percent(o.bounce_rate, 2)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div className="csince">{k}</div>
                    <div className="tnum" style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>{v}</div>
                  </div>
                ))}
              </div>
              {o.clients && o.clients.length > 1 ? (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}>
                  <div className="csince" style={{ marginBottom: 6 }}>By client</div>
                  {o.clients.slice(0, 4).map((c) => (
                    <div key={c.client} style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.client}
                      </span>
                      <span className="tnum mut">{fullNumber(c.sent)}</span>
                      <span className="tnum mut" style={{ width: 52, textAlign: "right" }}>
                        {percent(c.replies > 0 ? c.positive / c.replies : null, 1)}
                      </span>
                    </div>
                  ))}
                  {o.clients.length > 4 ? (
                    <div className="csince">+{o.clients.length - 4} more</div>
                  ) : null}
                </div>
              ) : null}
              {/* One click, every check: the copy-sequence route's dry run
                  and audit snapshot are what this reuses. Disabled without a
                  source — there is nothing to copy. */}
              <Btn
                disabled={busy || !o.source}
                onClick={() => setDeploying(o)}
                style={{ marginTop: 14, width: "100%" }}
              >
                Copy sequence to a campaign
              </Btn>
            </div>
          ),
        )}
      </div>
      <DeployDialog offer={deploying} onClose={() => setDeploying(null)} onStart={onDeploy} />
    </Box>
  );
}

/*
 * One-click deploy — the tool's `DeployDialog`.
 *
 * Reuses the §9.4 copy-sequence endpoint rather than a shortcut of its own, so
 * this inherits the whole safety story: the target's previous sequence is
 * snapshotted to the audit log before anything is written, Replace is refused
 * when a target step has already sent, and the "Re:" prefix is not
 * double-applied. "One click" describes the effort, not the number of checks.
 *
 * Every selected target is previewed, not just the first. With Replace the
 * answer differs per campaign — one may have nothing to delete while the next
 * has a step that has already sent and cannot be touched. A single preview
 * would be a confident answer about the wrong campaign.
 */
interface TargetPlan {
  targetId: number;
  ok: boolean;
  plan?: Pick<CopyPlan, "steps" | "removing" | "blocked" | "warnings">;
  error?: string;
}

function DeployDialog({
  offer,
  onClose,
  onStart,
}: {
  offer: OfferRow | null;
  onClose: () => void;
  onStart: (batch: DeployBatch) => void;
}) {
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [mode, setMode] = useState<CopyMode>("append");
  const [plans, setPlans] = useState<TargetPlan[]>([]);
  const [checking, setChecking] = useState(false);

  const open = Boolean(offer);
  const sourceId = offer?.source?.source_campaign_id ?? null;
  // The source cannot be its own target — excluded here so it can't be picked.
  const { options } = useCampaignOptions(open, sourceId ?? undefined);
  const nameOf = (id: number) => options.find((c) => c.id === id)?.name ?? `#${id}`;

  /*
   * One dry run per target, in parallel, whenever the selection or the mode
   * changes. A later change while a batch of previews is still in flight must
   * not be overwritten by it when it lands — hence the token.
   */
  const token = useRef(0);
  useEffect(() => {
    if (!open || sourceId == null || targetIds.length === 0) {
      token.current++;
      setPlans([]);
      setChecking(false);
      return;
    }
    const mine = ++token.current;
    setChecking(true);
    void Promise.all(
      targetIds.map(async (targetId): Promise<TargetPlan> => {
        try {
          const plan = await planCopySequence(targetId, sourceId, mode, {
            includeVariants: true,
            includeAttachments: true,
          });
          return { targetId, ok: true, plan };
        } catch (e) {
          return { targetId, ok: false, error: e instanceof Error ? e.message : "Cannot be written to" };
        }
      }),
    ).then((result) => {
      if (token.current !== mine) return;
      setPlans(result);
      setChecking(false);
    });
  }, [open, targetIds, mode, sourceId]);

  const close = () => {
    onClose();
    setTargetIds([]);
    setMode("append");
  };

  if (!offer) return null;

  const blocked = plans.filter((p) => !p.ok || p.plan?.blocked);
  const ready = plans.filter((p) => p.ok && !p.plan?.blocked);
  const stepsEach = ready[0]?.plan?.steps.length ?? offer.source?.step_count ?? 0;

  return (
    <DialogFrame
      open={open}
      onClose={close}
      width={560}
      title={`Copy “${offer.offer_name}” to campaigns`}
      description={
        <>
          {offer.source?.step_count} steps from{" "}
          <span style={{ color: "var(--ink)" }}>{offer.source?.source_name}</span>
        </>
      }
      footer={
        <>
          <Btn onClick={close}>Cancel</Btn>
          <Btn
            primary={mode !== "replace"}
            disabled={!ready.length || checking}
            style={mode === "replace" ? { color: "#fff", background: "var(--red)", borderColor: "var(--red)" } : undefined}
            onClick={() => {
              if (sourceId == null) return;
              onStart({
                sourceCampaignId: sourceId,
                sourceLabel: offer.offer_name,
                mode,
                // Only the ones that can actually take it. Queuing a known
                // failure just to report it later wastes a write attempt
                // against a live campaign.
                tasks: ready.map((p) => ({ campaignId: p.targetId, name: nameOf(p.targetId), status: "pending" as const })),
              });
              close();
            }}
          >
            {mode === "replace" ? "Replace in" : "Copy to"} {ready.length} {ready.length === 1 ? "campaign" : "campaigns"}
          </Btn>
        </>
      }
    >
      <div>
        <span className="as-l">Target campaigns</span>
        <CampaignMultiPicker options={options} value={targetIds} onChange={setTargetIds} />
      </div>

      <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
        {(["append", "replace"] as const).map((m) => (
          <label key={m} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" name="deploy-mode" checked={mode === m} onChange={() => setMode(m)} style={{ accentColor: "var(--blue)" }} />
            <span style={{ textTransform: "capitalize" }}>{m}</span>
          </label>
        ))}
      </div>

      {checking ? (
        <div className="mut" style={{ fontSize: 12.5 }}>
          Checking {targetIds.length} {targetIds.length === 1 ? "campaign" : "campaigns"}…
        </div>
      ) : null}

      {ready.length ? (
        <Panel style={{ background: "var(--inset)", fontSize: 12.5 }}>
          <b>{ready.length}</b> ready · {stepsEach} steps each
          {mode === "replace"
            ? ` · ${ready.reduce((n, p) => n + (p.plan?.removing.length ?? 0), 0)} existing steps will be deleted`
            : ""}
        </Panel>
      ) : null}

      {/* Named, not counted. "3 will fail" tells you to go and find out
          which; listing them with the reason is the whole point. */}
      {blocked.length ? (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>{blocked.length} will be skipped</div>
          <Panel style={{ maxHeight: 112, overflowY: "auto", minWidth: 0, borderColor: "var(--red)", background: "var(--red-bg)", fontSize: 12.5 }}>
            {blocked.map((p) => (
              <div key={p.targetId}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(p.targetId)}</div>
                <div style={{ color: "var(--red)" }}>{p.error ?? p.plan?.warnings[0] ?? "Cannot be written to"}</div>
              </div>
            ))}
          </Panel>
        </div>
      ) : null}
    </DialogFrame>
  );
}

/*
 * A searchable single-campaign picker — the tool's
 * `components/analytics/campaign-picker.tsx`.
 *
 * A native select over 95 campaigns whose names all begin "Jeff Cook Real
 * Estate LPT Realty + Nicole + …" is unusable: they differ in the last few
 * words, which is exactly the part a dropdown truncates and the part type-ahead
 * cannot reach, since native type-ahead matches from the START of the option.
 * Searching here matches anywhere in the name.
 *
 * EmailBison only, through `useCampaignOptions`: an offer's source is stored
 * as an integer id, and the copy-sequence route refuses an Instantly uuid.
 */
function CampaignPicker({
  value,
  onChange,
  placeholder = "Choose a campaign…",
  emptyLabel,
  exclude,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  /** When set, an explicit "no campaign" choice is offered with this label. */
  emptyLabel?: string;
  exclude?: number | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  // Loaded once opened — or straight away when there is a value whose name
  // the trigger has to show.
  const { options } = useCampaignOptions(open || value != null, exclude ?? undefined);
  const selected = options.find((c) => c.id === value);
  const q = search.trim().toLowerCase();
  const shown = q ? options.filter((c) => c.name.toLowerCase().includes(q)) : options;

  const choose = (id: number | null) => {
    onChange(id);
    setOpen(false);
  };

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    border: 0, background: "none", padding: "6px 8px", borderRadius: 6, cursor: "pointer",
    font: "inherit", fontSize: 12.5, color: "var(--ink-2)",
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sel"
        role="combobox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
      >
        <span className={selected ? undefined : "mut"} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.name ?? (value == null && emptyLabel ? emptyLabel : placeholder)}
        </span>
        <span aria-hidden className="mut">⇅</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={440} align="start" label="Choose a campaign">
        <div style={{ padding: 8, borderBottom: "1px solid var(--line-soft)" }}>
          <input
            className="inp"
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            aria-label="Search campaigns"
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto", padding: 4 }}>
          {emptyLabel && (!q || emptyLabel.toLowerCase().includes(q)) ? (
            <button type="button" onClick={() => choose(null)} style={{ ...rowStyle, color: "var(--muted)" }}>
              <span aria-hidden style={{ width: 14, flex: "none" }}>{value == null ? "✓" : ""}</span>
              {emptyLabel}
            </button>
          ) : null}
          {shown.length === 0 ? (
            <div className="mut" style={{ padding: 20, textAlign: "center", fontSize: 12.5 }}>No campaigns match</div>
          ) : (
            shown.map((c) => (
              <button key={c.id} type="button" onClick={() => choose(c.id)} style={rowStyle}>
                <span aria-hidden style={{ width: 14, flex: "none" }}>{value === c.id ? "✓" : ""}</span>
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span className="mut" style={{ flex: "none", fontSize: 12 }}>{c.status}</span>
              </button>
            ))
          )}
        </div>
      </AnchoredPanel>
    </>
  );
}

function OfferForm({
  title,
  initialName = "",
  initialNiche = "",
  initialSourceId = null,
  sourceEmptyLabel,
  sourceHint,
  busy,
  onSave,
  onCancel,
  onDelete,
  deleteTitle,
}: {
  title: string;
  initialName?: string;
  initialNiche?: string;
  /** The offer's nominated source campaign; null is "automatic". */
  initialSourceId?: number | null;
  /** Offered as an explicit "no campaign" choice — the tool's Edit dialog only. */
  sourceEmptyLabel?: string;
  sourceHint?: string;
  busy: boolean;
  onSave: (name: string, niche: string | null, sourceCampaignId: number | null) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  deleteTitle?: string;
}) {
  const [name, setName] = useState(initialName);
  const [niche, setNiche] = useState(initialNiche);
  const [sourceId, setSourceId] = useState<number | null>(initialSourceId);

  return (
    <div style={{ padding: 18, borderBottom: "1px solid var(--line-soft)", background: "var(--inset)" }}>
      <div className="card-l" style={{ marginBottom: 10 }}>{title}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "block" }}>
          <span className="as-l">Name</span>
          <input
            className="inp" value={name} autoFocus
            placeholder="e.g. Zillow Flex"
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 260 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="as-l">Niche</span>
          <input
            className="inp" value={niche}
            placeholder="optional"
            onChange={(e) => setNiche(e.target.value)}
            style={{ minWidth: 200 }}
          />
        </label>
        {/* The offer IS a sequence, so it needs one to be worth anything. */}
        <div style={{ display: "block", minWidth: 300, flex: "1 1 300px" }}>
          <span className="as-l">Sequence from</span>
          <CampaignPicker value={sourceId} onChange={setSourceId} emptyLabel={sourceEmptyLabel} disabled={busy} />
        </div>
        <Btn primary disabled={busy || !name.trim()} onClick={() => void onSave(name.trim(), niche.trim() || null, sourceId)}>
          Save
        </Btn>
        <Btn disabled={busy} onClick={onCancel}>Cancel</Btn>
        {onDelete ? (
          <ConfirmButton
            label="Delete"
            armedLabel="Confirm delete"
            title={deleteTitle ?? "Delete this offer?"}
            disabled={busy}
            onConfirm={() => void onDelete()}
          />
        ) : null}
      </div>
      {sourceHint ? (
        <div className="csince" style={{ marginTop: 8 }}>{sourceHint}</div>
      ) : null}
    </div>
  );
}

/* ------------------------------ suggestions -------------------------------- */

function Suggestions({
  suggestions,
  busy,
  onRun,
}: {
  suggestions: Suggestion[];
  busy: boolean;
  onRun: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  if (!suggestions.length) return null;

  return (
    <Box
      title="Suggested groups"
      note="Campaigns already sharing an opening email. Naming one turns it into an offer you can measure."
    >
      <div
        className="grid2"
        style={{ padding: 22, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
      >
        {suggestions.slice(0, 8).map((s) => {
          const seeded = names[s.fingerprint] ?? s.example_subject.replace(/\?$/, "").slice(0, 60);
          return (
            <div key={s.fingerprint} style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 16, minWidth: 0 }}>
              <div className="cname" style={{ fontSize: 14 }}>{s.example_subject}</div>
              <div className="csince">
                {s.campaigns} campaigns · {s.variants} subject variants
                {s.claimed > 0 ? ` · ${s.claimed} already in an offer` : ""}
              </div>
              {/* The same affordance as a real offer card — you are about to
                  name this group, and the sequence is what you are naming. */}
              <SequenceLink
                campaignId={s.source_campaign_id}
                campaignName={s.source_name}
                stepCount={s.step_count}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 14 }}>
                {[
                  ["Sent", fullNumber(s.sent)],
                  ["Reply %", percent(s.reply_rate, 2)],
                  ["Positive %", percent(s.positive_rate, 2)],
                  ["Bounce %", percent(s.bounce_rate, 2)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div className="csince">{k}</div>
                    <div className="tnum" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  className="inp"
                  value={seeded}
                  aria-label="Offer name"
                  onChange={(e) => setNames((n) => ({ ...n, [s.fingerprint]: e.target.value }))}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <Btn
                  primary
                  disabled={busy || !seeded.trim()}
                  onClick={() =>
                    void onRun(
                      `Created “${seeded.trim()}” from ${s.campaigns} campaigns`,
                      () =>
                        createOffer(seeded.trim(), null, s.source_campaign_id, s.campaign_ids),
                    )
                  }
                >
                  Create offer
                </Btn>
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}

/* -------------------------------- spintax ---------------------------------- */

function Spintax({ spintax }: { spintax: SpintaxRow[] }) {
  const unvaried = spintax.filter((r) => r.status === "none" && r.sent > 0);
  if (!unvaried.length) return null;

  const known = spintax.filter((r) => r.status !== "unknown");
  const totalSent = known.reduce((s, r) => s + r.sent, 0);
  const unvariedSent = unvaried.reduce((s, r) => s + r.sent, 0);

  return (
    <Box
      title="Copy that never changes"
      note={`${fullNumber(unvariedSent)} of ${fullNumber(totalSent)} sends in range · ${percent(
        totalSent > 0 ? unvariedSent / totalSent : null,
        0,
      )}`}
    >
      <div style={{ padding: "14px 22px 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
        Every recipient of these campaigns got a byte-identical email. Spintax —{" "}
        <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{"{{Hi | Hello | Hey}}"}</code> —
        is what varies it. Campaigns that vary through step VARIANTS instead are not listed here.
      </div>
      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Client</th>
              <th style={{ textAlign: "right" }}>Steps</th>
              <th style={{ textAlign: "right" }}>Sent in range</th>
            </tr>
          </thead>
          <tbody>
            {unvaried.slice(0, 12).map((r) => (
              <tr key={`${r.platform ?? "eb"}-${r.campaign_id}`}>
                <td>{r.campaign_name}</td>
                <td className="mut">{r.client_name ?? "Unassigned"}</td>
                <td className="tnum" style={{ textAlign: "right" }}>{r.steps}</td>
                <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unvaried.length > 12 ? (
        <div style={{ padding: "12px 22px 18px", fontSize: 12.5, color: "var(--muted)" }}>
          and {unvaried.length - 12} more
        </div>
      ) : null}
    </Box>
  );
}

/* ------------------------------- copy table -------------------------------- */

function CopyTable({
  data,
  dimensions,
  setDimensions,
  busy,
  onRun,
  loading,
}: {
  data: CopyResponse | null;
  dimensions: CopyDimensionKey[];
  setDimensions: (next: CopyDimensionKey[]) => void;
  busy: boolean;
  onRun: (what: string, fn: () => Promise<unknown>) => Promise<void>;
  loading: boolean;
}) {
  const { sort, toggle } = useSort();
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const closeAdd = useCallback(() => setAdding(false), []);

  const coverage = data?.coverage;
  const coverPct =
    coverage && coverage.total_sent > 0 ? coverage.tagged_sent / coverage.total_sent : 0;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = (data?.rows ?? []).filter(
      (r) => !needle || r.values.some((v) => v.toLowerCase().includes(needle)),
    );
    const sorted = sortRows(base, sort, (r, key) => (r as unknown as Record<string, number | string | null>)[key]);
    /*
     * Untagged is pinned to the bottom under EVERY sort. It is a real row —
     * hiding it would make the table's own coverage invisible — but it is the
     * absence of an answer, and letting it win a sort puts "we didn't label
     * this" at the top of a ranking of what works.
     */
    return sort ? [...sorted.filter((r) => !r.untagged), ...sorted.filter((r) => r.untagged)] : sorted;
  }, [data, sort, q]);

  const medals = useMemo(() => awardMedals(rows.filter((r) => !r.untagged)), [rows]);

  // The table body has dimensions.length + 8 columns. The tool writes + 7 in
  // three places, so its expanded row is a column short of the table above it.
  const colSpan = dimensions.length + 8;

  return (
    <Box
      title="How the copy performs"
      note={
        data ? (
          <>
            {rangeLabel(data.from, data.to)} · every campaign&rsquo;s opening email, grouped by how
            its {dimensions.map((d) => COPY_DIMENSIONS.find((c) => c.key === d)?.label ?? d).join(" + ")}{" "}
            was written.
          </>
        ) : undefined
      }
      right={
        <>
          <Search value={q} onChange={setQ} placeholder="Search values…" width={190} />
          {/*
            The tool renders this only at exactly zero coverage. Below half is
            when it is worth pressing, and it is idempotent — it writes only
            where no tag exists.
          */}
          {coverPct < 0.5 ? (
            <Btn
              disabled={busy}
              title="Seeds a subject-line type for every untagged first email. It never overwrites a tag that already exists."
              onClick={() => void onRun("Subject types suggested", suggestCopyTags)}
            >
              Suggest subject types
            </Btn>
          ) : null}
        </>
      }
      style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
    >
      <div style={{ padding: "16px 22px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="card-l" style={{ margin: 0 }}>Dimension:</span>
        {dimensions.map((d) => (
          <span key={d} className="schip">
            {COPY_DIMENSIONS.find((c) => c.key === d)?.label ?? d}
            <button
              type="button"
              aria-label={`Remove ${d}`}
              disabled={dimensions.length === 1}
              onClick={() => setDimensions(dimensions.filter((x) => x !== d))}
              style={{
                border: 0, background: "none", cursor: dimensions.length === 1 ? "not-allowed" : "pointer",
                color: "var(--muted)", opacity: dimensions.length === 1 ? 0.3 : 1,
                /*
                 * `padding: 0` made this an 8x19 target — the smallest control
                 * on the screen, and the one that removes a column. Padding
                 * gives it a 24px hit area; the negative margin means the chip
                 * it sits in does not grow.
                 */
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                minWidth: 24, minHeight: 24, margin: "-4px -6px", borderRadius: 6,
              }}
            >
              ×
            </button>
          </span>
        ))}
        <span style={{ position: "relative" }}>
          <button
            ref={addRef}
            type="button" className="gh" aria-expanded={adding} onClick={() => setAdding((v) => !v)}
          >
            + Add dimension
          </button>
          {/*
            Portalled — this toolbar clips, and the panel was measured at 0%
            visible. See ui/anchored-panel.tsx.
          */}
          <AnchoredPanel
            anchorRef={addRef}
            open={adding}
            onClose={closeAdd}
            width={300}
            label="Add dimension"
          >
            <div style={{ padding: 6, overflowY: "auto", flex: 1, minHeight: 0 }}>
              {COPY_DIMENSIONS.filter((c) => !dimensions.includes(c.key)).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => { setDimensions([...dimensions, c.key]); setAdding(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", border: 0, background: "none",
                    padding: "8px 10px", borderRadius: 8, font: "inherit", fontSize: 13, cursor: "pointer",
                    color: "var(--ink-2)",
                  }}
                >
                  <b>{c.label}</b>
                  {c.hint ? <div className="csince">{c.hint}</div> : null}
                </button>
              ))}
              {COPY_DIMENSIONS.every((c) => dimensions.includes(c.key)) ? (
                <div className="mut" style={{ padding: 10, fontSize: 13 }}>All seven are in use.</div>
              ) : null}
            </div>
          </AnchoredPanel>
        </span>
      </div>

      {coverage ? (
        <div
          style={{
            padding: "12px 22px 0", fontSize: 12.5,
            color: coverPct < 0.5 ? "var(--yellow)" : "var(--muted)",
          }}
        >
          {percent(coverPct, 0)} of first-email sending is tagged on{" "}
          {dimensions.length === 1 ? "this dimension" : "all these dimensions"} —{" "}
          {fullNumber(coverage.tagged_sent)} of {fullNumber(coverage.total_sent)} sends.
          {coverPct < 0.5 ? " A table built from part of the sending cannot describe all of it." : ""}
        </div>
      ) : null}

      <div className="tbl-scroll" style={{ marginTop: 12 }}>
        <table className="atbl" style={{ minWidth: 300 + dimensions.length * 190 + 8 * 92 }}>
          <thead>
            <tr>
              {dimensions.map((d) => (
                <th key={d}>{COPY_DIMENSIONS.find((c) => c.key === d)?.label ?? d}</th>
              ))}
              <SortHeader label="Steps" sortKey="steps" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Replies" sortKey="replies" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Reply %" sortKey="reply_rate" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Positive %" sortKey="positive_rate" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Bounce %" sortKey="bounce_rate" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Pos" sortKey="positive" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Meetings" sortKey="meetings" sort={sort} onToggle={toggle} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={colSpan}>
                {data ? "Nothing tagged on this dimension in this window." : "Loading…"}
              </EmptyRow>
            ) : (
              rows.map((r) => (
                <RowView
                  key={r.key}
                  row={r}
                  medal={medals.get(r)}
                  dimensions={dimensions}
                  colSpan={colSpan}
                  open={open === r.key}
                  onToggle={() => setOpen(open === r.key ? null : r.key)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "14px 22px 20px", fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
        First email only, and NOT its variants —{" "}
        <code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>analytics_copy_steps</code> ends
        {" "}<code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>AND NOT st.is_variant</code>.
        Medals mark the best positive rate among values with at least{" "}
        {MEDAL_MIN_SENT.toLocaleString("en-US")} sends.
      </div>
    </Box>
  );
}

function RowView({
  row,
  medal,
  dimensions,
  colSpan,
  open,
  onToggle,
}: {
  row: CopyRow;
  medal: string | undefined;
  dimensions: CopyDimensionKey[];
  colSpan: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: "pointer", background: open ? "var(--inset)" : undefined }}
      >
        {dimensions.map((d, i) => (
          <td key={d} style={{ color: row.untagged ? "var(--muted)" : "var(--ink-2)" }}>
            {i === 0 && medal ? <span style={{ marginRight: 6 }}>{medal}</span> : null}
            {i === 0 ? <span aria-hidden style={{ marginRight: 6, color: "var(--muted)" }}>{open ? "▾" : "▸"}</span> : null}
            {row.values[i] ?? DASH}
          </td>
        ))}
        <td className="tnum" style={{ textAlign: "right" }}>{row.steps}</td>
        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(row.sent)}</td>
        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(row.replies)}</td>
        <td className="tnum" style={{ textAlign: "right" }}>{percent(row.reply_rate, 2)}</td>
        <td className="tnum" style={{ textAlign: "right" }}>{percent(row.positive_rate, 2)}</td>
        <td
          className="tnum"
          style={{ textAlign: "right", color: (row.bounce_rate ?? 0) >= 0.03 ? "var(--red)" : undefined }}
        >
          {percent(row.bounce_rate, 2)}
        </td>
        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(row.positive)}</td>
        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(row.meetings)}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={colSpan} style={{ background: "var(--inset)", padding: "12px 18px" }}>
            <table className="atbl" style={{ background: "var(--surface)", borderRadius: 10, overflow: "hidden" }}>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Campaign</th>
                  <th style={{ textAlign: "right" }}>Sent</th>
                  <th style={{ textAlign: "right" }}>Reply %</th>
                  <th style={{ textAlign: "right" }}>Positive %</th>
                  <th style={{ textAlign: "right" }}>Bounce %</th>
                </tr>
              </thead>
              <tbody>
                {row.members.map((m) => (
                  <tr key={m.id}>
                    <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.subject || <span className="mut">(no subject)</span>}
                    </td>
                    <td className="mut" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.campaign}
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(m.sent)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{percent(m.reply_rate, 2)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{percent(m.positive_rate, 2)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{percent(m.bounce_rate, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ------------------------- the sequence, one click away ------------------- */

/*
 * The whole sequence behind an offer, without leaving Copy & Offer — the
 * tool's `SequenceLink` + `sequence-dialog.tsx`.
 *
 * The card said "3 steps from <campaign>" and stopped there, so the only way to
 * read the emails you were about to copy into other campaigns was to leave,
 * find the campaign, and open its Sequence tab. It is the same sentence — now
 * it opens.
 *
 * It reads the SAME endpoint the campaign detail screen reads
 * (`CAMPAIGN_URL(id)`, whose `sequence` is already nested: variants under the
 * step they replace, orphans promoted), so the steps and the waits cannot say
 * one thing here and another there.
 */

interface SequenceStep {
  id: number;
  step_order: number | null;
  email_subject: string | null;
  email_body: string | null;
  wait_in_days: number | null;
  thread_reply: boolean;
  orphanedVariant?: boolean;
  stats: { sent: number; replies: number; bounced: number } | null;
  variants: Array<Omit<SequenceStep, "variants">>;
}

interface SequenceDetail {
  campaign: { id: number | string; name: string; status: string };
  sequence: SequenceStep[];
}

/** "3 steps · 2 variants" — a variant occupies its parent's slot, never adds one. */
function describeSequence(steps: SequenceStep[]): string {
  const variants = steps.reduce((n, s) => n + s.variants.length, 0);
  const stepPart = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return variants ? `${stepPart} · ${variants} variant${variants === 1 ? "" : "s"}` : stepPart;
}

function SequenceLink({
  campaignId,
  campaignName,
  stepCount,
}: {
  campaignId: number;
  campaignName: string;
  stepCount: number;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        className="cmeta"
        onClick={() => setOpen(true)}
        title={`View the full sequence from ${campaignName}`}
        /*
         * `.cmeta` is inline-flex, so the span below is a flex child — but the
         * button must also be allowed to SHRINK (minWidth 0) inside a card that
         * is itself constrained, or the ellipsis is decorative: measured on
         * production, a long campaign name ran 591px past its card.
         */
        style={{ marginTop: 10, cursor: "pointer", font: "inherit", maxWidth: "100%", minWidth: 0 }}
      >
        <span style={{ display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stepCount} {stepCount === 1 ? "step" : "steps"} from{" "}
          <span style={{ color: "var(--ink)" }}>{campaignName}</span>
        </span>
        <span aria-hidden>›</span>
      </button>
      <SequenceDialog campaignId={campaignId} campaignName={campaignName} open={open} onClose={close} />
    </>
  );
}

function SequenceDialog({
  campaignId,
  campaignName,
  open,
  onClose,
}: {
  campaignId: number;
  campaignName: string;
  open: boolean;
  onClose: () => void;
}) {
  // Only once it is actually opened — an offer grid is 20+ cards and
  // prefetching every sequence would be 20 requests for one you might read.
  const { data, error, loading } = useAnalyticsData<SequenceDetail>(CAMPAIGN_URL(String(campaignId)), {
    skip: !open,
  });
  const steps = data?.sequence ?? [];

  return (
    <ModalDialog open={open} onClose={onClose} width={760} label={`Sequence from ${campaignName}`}>
      <div className="abox-h" style={{ flex: "none", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{campaignName}</h2>
          <div className="note">
            {steps.length ? describeSequence(steps) : "Sequence"}
            <span aria-hidden> · </span>
            <Link href={`/analytics/campaigns/${campaignId}`} style={{ color: "var(--blue)" }}>
              Open campaign ↗
            </Link>
          </div>
        </div>
        <span className="an-head-tools">
          <Btn onClick={onClose}>Close</Btn>
        </span>
      </div>
      <div style={{ minHeight: 0, flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {loading && !data ? (
          <div className="mut" style={{ padding: "40px 22px", textAlign: "center" }}>Loading sequence…</div>
        ) : error ? (
          <div style={{ padding: "40px 22px", textAlign: "center", color: "var(--red)" }}>{error}</div>
        ) : steps.length === 0 ? (
          <div className="mut" style={{ padding: "40px 22px", textAlign: "center" }}>
            This campaign has no sequence steps cached.
          </div>
        ) : (
          <SequenceSteps steps={steps} />
        )}
      </div>
    </ModalDialog>
  );
}

/**
 * The steps, read-only, in the shape the campaign detail screen draws them.
 *
 * Bodies are rendered as TEXT, not HTML — the workspace's rule for every
 * sequence body (see campaign-detail.tsx): these would be injected into the
 * shell that holds every other tool's session, and the braces are the thing
 * you came to read anyway.
 */
function SequenceSteps({ steps }: { steps: SequenceStep[] }) {
  const [open, setOpen] = useState<number | null>(steps[0]?.id ?? null);

  return (
    <>
      {steps.map((step, index) => {
        const previousWait = index > 0 ? steps[index - 1].wait_in_days : null;
        const on = open === step.id;
        return (
          <div key={step.id} style={{ borderTop: index ? "1px solid var(--line-soft)" : undefined }}>
            <button
              type="button"
              onClick={() => setOpen(on ? null : step.id)}
              aria-expanded={on}
              style={{
                display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left",
                border: 0, background: "none", padding: "14px 22px", cursor: "pointer", font: "inherit",
              }}
            >
              <span className="tile" style={{ width: 28, height: 28, fontSize: 12, fontWeight: 600 }}>
                {index + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {step.email_subject || "(no subject)"}
                </span>
                <span className="csince">
                  {/* The gap BEFORE this step is the previous step's wait —
                      EmailBison's definition, and the tool's choice too. */}
                  {index === 0
                    ? "sends immediately"
                    : previousWait
                      ? `${previousWait}d after step ${index}`
                      : "immediately after"}
                  {step.thread_reply ? " · replies in thread" : ""}
                  {step.variants.length ? ` · ${step.variants.length} variant${step.variants.length === 1 ? "" : "s"}` : ""}
                  {step.orphanedVariant ? " · orphaned variant" : ""}
                </span>
              </span>
              {step.stats ? (
                <span className="tnum mut" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                  {fullNumber(step.stats.sent)} sent · {fullNumber(step.stats.replies)} replies
                </span>
              ) : null}
              <span aria-hidden style={{ color: "var(--muted)" }}>{on ? "▾" : "▸"}</span>
            </button>
            {on ? (
              <div style={{ padding: "0 22px 20px" }}>
                <SequenceEmail subject={step.email_subject} body={step.email_body} />
                {step.variants.map((v, vi) => (
                  <div key={v.id} style={{ marginTop: 12, paddingLeft: 18, borderLeft: "2px solid var(--line)" }}>
                    <div className="csince" style={{ marginBottom: 6 }}>
                      Variant {String.fromCharCode(65 + vi)}
                      {v.stats ? ` · ${fullNumber(v.stats.sent)} sent · ${fullNumber(v.stats.replies)} replies` : ""}
                    </div>
                    <SequenceEmail subject={v.email_subject} body={v.email_body} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function SequenceEmail({ subject, body }: { subject: string | null; body: string | null }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
      <div className="msg-hdrs">
        <span><b>Subj</b> {subject || "(no subject)"}</span>
      </div>
      <pre
        style={{
          margin: 0, padding: "14px 16px", fontSize: 12.5, lineHeight: 1.6,
          fontFamily: "var(--mono)", color: "var(--ink-2)", whiteSpace: "pre-wrap",
          wordBreak: "break-word", maxHeight: 340, overflowY: "auto",
        }}
      >
        {body || "(empty)"}
      </pre>
    </div>
  );
}
