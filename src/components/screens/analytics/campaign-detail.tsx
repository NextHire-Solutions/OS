"use client";

import { useState } from "react";
import Link from "next/link";

import { spintaxOf } from "@/lib/tools/analytics/campaigns/spintax-signal.ts";
import { DASH, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import { fullStamp } from "@/lib/workspace/dates";
import {
  CAMPAIGN_URL,
  saveCampaignSettings,
  setCampaignOffer,
  useAnalyticsData,
  type CampaignSettingsPatch,
  applyCampaignAction,
} from "./actions";
import { AssignInboxesDialog } from "./assign-inboxes-dialog";
import { BulkDeployPanel, useBulkDeploy } from "./bulk-deploy";
import { CampaignLeads } from "./campaign-leads";
import { CopySequenceDialog } from "./copy-sequence-dialog";
import { CopyTagsPanel } from "./copy-tags-panel";
import { EmailPanel } from "./email-panel";
import { FanOutDialog } from "./fan-out-dialog";
import { PushSequenceDialog } from "./push-sequence-dialog";
import { ReCampaignDialog } from "./re-campaign-dialog";
import { SequenceEditor, type EditableStep } from "./sequence-editor";
import { Bar, Box, EmptyRow, LoadError, Seg } from "./shared";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * One campaign — the drill-down at `/campaigns/[id]` in the tool.
 *
 * THIS SCREEN HAS NO NAV DESTINATION. The workspace's rail has seven Analytics
 * leaves and none of them is a campaign, which is correct: a campaign is a row
 * you open, not a place you go. It is reached from the Campaigns list, and that
 * is written up in ANALYTICS-WIRING.md so the owner can decide whether it also
 * deserves an address of its own.
 *
 * The tool's six tabs, all of them:
 *
 *   Overview · Leads · Sequence · Copy & Offer · Settings · Activity
 *
 * Every one WRITES where the tool writes. The sequence editor, the Leads tab
 * with removal, the four bulk dialogs (copy-sequence, push, re-campaign,
 * fan-out) and inbox assignment each live in their own file beside this one —
 * mutating EmailBison or Instantly irreversibly is exactly why each carries the
 * tool's own confirmation ritual (a dry run before a copy, a typed name before
 * a replace, an armed second click before a discard) rather than a plain
 * button. Settings stays EmailBison-only, which is a real platform difference
 * and not pending work; so do copy/push/re-campaign/fan-out, whose routes
 * address campaigns by EmailBison's integer id — those buttons say so on an
 * Instantly campaign instead of failing after the click.
 */

interface Stats {
  sent: number;
  contacted: number;
  opens: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
}

interface Step {
  id: number;
  step_order: number;
  email_subject: string | null;
  email_body: string | null;
  wait_in_days: number | null;
  is_variant: boolean;
  variant_from_step_id: number | null;
  thread_reply: boolean;
  attachments: unknown[];
  stats: Stats | null;
  orphanedVariant?: boolean;
  variants: Step[];
}

interface Campaign {
  id: number | string;
  name: string;
  status: string;
  tags: unknown[];
  max_emails_per_day: number | null;
  max_new_leads_per_day: number | null;
  total_leads: number | null;
  lifetime_emails_sent: number | null;
  lifetime_opened: number | null;
  lifetime_unique_opens: number | null;
  lifetime_replied: number | null;
  lifetime_unique_replies: number | null;
  lifetime_bounced: number | null;
  lifetime_unsubscribed: number | null;
  lifetime_interested: number | null;
  total_leads_contacted: number | null;
  completion_percentage: number | null;
  plain_text: boolean | null;
  open_tracking: boolean | null;
  can_unsubscribe: boolean | null;
  unsubscribe_text: string | null;
  include_auto_replies_in_stats: boolean | null;
  eb_created_at: string | null;
  eb_updated_at: string | null;
  /** EmailBison's handle on the sequence; the editor saves through it. Absent on Instantly. */
  sequence_id?: number | null;
  clientId: string | null;
  excluded: boolean;
  excludeReason: string | null;
  offer_id: string | null;
}

interface Activity {
  id: number;
  action: string;
  actor: string | null;
  status: string;
  error: string | null;
  before_state: unknown;
  after_state: unknown;
  created_at: string;
}

interface DetailResponse {
  platform?: "emailbison" | "instantly";
  campaign: Campaign;
  sequence: Step[];
  variantCount: number;
  activity: Activity[];
  sentStepIds: number[];
}

type Tab = "overview" | "leads" | "sequence" | "copy" | "settings" | "activity";

export function CampaignDetailScreen({ id, onBack }: { id: string; onBack?: () => void }) {
  const { data, error, loading, reload } = useAnalyticsData<DetailResponse>(CAMPAIGN_URL(id));
  const [tab, setTab] = useState<Tab>("overview");
  const { toast, show } = useToast();
  const [acting, setActing] = useState(false);
  const [assigningInboxes, setAssigningInboxes] = useState(false);

  /*
   * Pause / Resume, on the page that shows the campaign.
   *
   * The tool has these on the detail header. The workspace had none — you went
   * back to the list, ticked a box and used the selection bar. Same helper as
   * that bar, same two-step arm on Resume, because Resume is the one action
   * that starts sending and is not an undo.
   */
  async function act(action: "pause" | "resume") {
    if (!data?.platform) return;
    setActing(true);
    try {
      const r = await applyCampaignAction(action, [{ platform: data.platform, id: String(data.campaign.id) }]);
      if (r.failed) throw new Error(r.results?.find((x) => x.error)?.error ?? `${action} failed`);
      await reload();
      show({ text: action === "pause" ? "Paused" : "Resumed — sending" });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : `${action} failed`, bad: true });
    } finally {
      setActing(false);
    }
  }

  if (error) return <LoadError what="This campaign" error={error} />;
  if (!data) return <div className="wrap an-screen"><div className="mut">Loading…</div></div>;

  const c = data.campaign;
  const isInstantly = data.platform === "instantly";
  const steps = data.sequence ?? [];
  const spintax = spintaxOf(
    steps.map((s) => ({ email_body: s.email_body ?? "", email_subject: s.email_subject ?? "" })),
  );

  /*
   * Settings is EmailBison-only, and that is a real platform difference rather
   * than pending work: `PATCH /api/campaigns/{id}/settings` calls EmailBison's
   * update endpoint, and Instantly's campaign object has no equivalent for most
   * of these fields.
   */
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "overview", label: "Overview" },
    { value: "leads", label: "Leads" },
    { value: "sequence", label: "Sequence" },
    { value: "copy", label: "Copy & Offer" },
    ...(isInstantly ? [] : [{ value: "settings" as Tab, label: "Settings" }]),
    { value: "activity", label: "Activity" },
  ];
  const platformName = isInstantly ? "Instantly" : "EmailBison";

  return (
    <div className="wrap an-screen" style={{ opacity: loading ? 0.7 : 1, transition: "opacity .14s" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {/*
          A link, always. `onBack` is a callback, and this screen is mounted
          from a server component that cannot pass one — so it was always
          undefined and the back button never rendered. Same defect and same
          fix as the campaign names on the list.
        */}
        {onBack ? (
          <Btn onClick={onBack}>← Campaigns</Btn>
        ) : (
          <Link href="/analytics/campaigns" className="btn" style={{ textDecoration: "none" }}>← Campaigns</Link>
        )}
        {(() => {
          const st = String(c.status).toLowerCase();
          const canPause = !["paused", "completed", "archived", "draft"].includes(st);
          const canResume = st === "paused";
          const noPlatform = !data.platform;
          if (canResume) {
            return (
              <ConfirmButton
                primary
                label="Resume"
                armedLabel="Confirm resume — starts sending"
                title={noPlatform ? "Platform unknown for this campaign" : "Resume queues this campaign to SEND. It does not restore a previous status."}
                disabled={acting || noPlatform}
                onConfirm={() => void act("resume")}
              />
            );
          }
          if (canPause) {
            return (
              <Btn disabled={acting || noPlatform} title={noPlatform ? "Platform unknown for this campaign" : undefined} onClick={() => void act("pause")}>
                {acting ? "…" : "Pause"}
              </Btn>
            );
          }
          return null;
        })()}
        {/*
          Separated from Pause/Resume because it is a different kind of change:
          those move a campaign through its lifecycle, this decides which
          mailboxes send for it. It has no eligibility rule — any campaign can
          be given inboxes — and the tool offers it for both platforms.
        */}
        {data.platform ? (
          <>
            <Btn onClick={() => setAssigningInboxes(true)}>Inboxes</Btn>
            <AssignInboxesDialog
              targets={[{ platform: data.platform, id: String(c.id) }]}
              open={assigningInboxes}
              onOpenChange={setAssigningInboxes}
              onDone={() => void reload()}
            />
          </>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>{c.name}</div>
          <div className="tbl-sub">
            <span className="badge s-done" style={{ marginRight: 8 }}>{c.status}</span>
            {c.max_emails_per_day ? `${fullNumber(c.max_emails_per_day)}/day · ` : ""}
            {data.variantCount} variant{data.variantCount === 1 ? "" : "s"}
            {c.eb_created_at ? ` · created ${fullStamp(c.eb_created_at)}` : ""}
            {c.excluded ? ` · excluded — ${c.excludeReason ?? "not a client campaign"}` : ""}
          </div>
        </div>
      </div>

      <Seg label="Campaign tab" value={tab} options={tabs} onChange={setTab} full />

      <div style={{ marginTop: 20 }}>
        {tab === "overview" ? <Overview campaign={c} isInstantly={isInstantly} /> : null}
        {tab === "leads" ? (
          <CampaignLeads campaignId={String(c.id)} campaignName={c.name} platformName={platformName} />
        ) : null}
        {tab === "sequence" ? (
          <Sequence
            steps={steps}
            varied={spintax.varied}
            campaignId={String(c.id)}
            campaignName={c.name}
            platform={data.platform ?? "emailbison"}
            sequenceId={c.sequence_id ?? null}
            sentStepIds={data.sentStepIds ?? []}
            show={show}
            onChanged={() => void reload()}
          />
        ) : null}
        {tab === "copy" ? (
          <CopyAndOffer
            campaignId={String(c.id)}
            offerId={c.offer_id}
            firstStep={steps.find((s) => !s.is_variant) ?? null}
            isInstantly={isInstantly}
            show={show}
            onSaved={() => void reload()}
          />
        ) : null}
        {tab === "settings" ? (
          <Settings campaign={c} show={show} onSaved={() => void reload()} />
        ) : null}
        {tab === "activity" ? <ActivityLog rows={data.activity ?? []} /> : null}
      </div>
      <Toast toast={toast} />
    </div>
  );
}

function Overview({ campaign: c, isInstantly }: { campaign: Campaign; isInstantly: boolean }) {
  const sent = c.lifetime_emails_sent ?? 0;
  const funnel = [
    ["Sent", c.lifetime_emails_sent],
    ["Replied", c.lifetime_unique_replies],
    ["Interested", c.lifetime_interested],
    ["Bounced", c.lifetime_bounced],
  ] as const;

  return (
    <>
      <Box title="Progress">
        <div style={{ padding: 22 }}>
          {c.completion_percentage == null ? (
            <span className="mut">{DASH}</span>
          ) : (
            <>
              <div className="card-n tnum" style={{ fontSize: 28 }}>
                {Math.round(c.completion_percentage)}%
              </div>
              <div style={{ marginTop: 10 }}>
                <Bar fraction={c.completion_percentage / 100} color="var(--blue)" />
              </div>
            </>
          )}
        </div>
      </Box>

      <Box title="Funnel" note="Lifetime totals, as the platform reports them.">
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 13 }}>
          {funnel.map(([label, n]) => (
            <div key={label}>
              <div style={{ display: "flex", gap: 10, fontSize: 13, marginBottom: 4 }}>
                <span style={{ flex: 1 }}>{label}</span>
                <span className="tnum">{fullNumber(n)}</span>
                <span className="tnum mut" style={{ width: 60, textAlign: "right" }}>
                  {n == null ? DASH : percent(sent > 0 ? n / sent : null, 2)}
                </span>
              </div>
              {/* No bar at all for a null — an empty track claims zero. */}
              {n == null ? null : <Bar fraction={sent > 0 ? n / sent : 0} color="var(--blue)" />}
            </div>
          ))}
        </div>
      </Box>

      <Box title="Detail">
        <div style={{ padding: 22, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          {([
            ["Leads", c.total_leads],
            ["Contacted", c.total_leads_contacted],
            ["Opened", c.lifetime_opened],
            ["Unique opens", c.lifetime_unique_opens],
            ["Replied", c.lifetime_replied],
            ["Unique replies", c.lifetime_unique_replies],
            ["Bounced", c.lifetime_bounced],
            ["Unsubscribed", c.lifetime_unsubscribed],
            ["Interested", c.lifetime_interested],
            ["Daily cap", c.max_emails_per_day],
          ] as const).map(([k, v]) => (
            <div key={k}>
              <div className="csince">{k}</div>
              <div className="tnum" style={{ fontSize: 17, fontWeight: 600, color: "var(--ink)" }}>
                {fullNumber(v)}
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: "0 22px 20px", fontSize: 12, color: "var(--muted)" }}>
          Lifetime totals as {isInstantly ? "Instantly" : "EmailBison"} reports them. They are
          cumulative counters and cannot be windowed — anything date-ranged comes from the
          Campaign screen.
        </div>
      </Box>
    </>
  );
}

/*
 * The Sequence tab: the read view with the tool's five tools above it —
 * Edit sequence · Copy sequence from… · Push to campaigns… · Re-campaign… ·
 * For multiple clients… — and the editor in place of the read view while
 * editing. The bulk-deploy panel sits above everything while a push runs.
 */
function Sequence({
  steps,
  varied,
  campaignId,
  campaignName,
  platform,
  sequenceId,
  sentStepIds,
  show,
  onChanged,
}: {
  steps: Step[];
  varied: boolean;
  campaignId: string;
  campaignName: string;
  platform: "emailbison" | "instantly";
  sequenceId: number | null;
  sentStepIds: number[];
  show: (t: { text: string; bad?: boolean }) => void;
  /** The tool's `invalidateQueries(["campaign", id])`. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<number | null>(steps[0]?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [reCampaigning, setReCampaigning] = useState(false);
  const [fanningOut, setFanningOut] = useState(false);
  const deploy = useBulkDeploy(onChanged);

  /*
   * Variants are flattened back out for editing. The read view nests them under
   * their parent, but EmailBison's sequence is a flat ordered list and saving a
   * nested shape would have to invent an ordering for the variants.
   */
  const editable: EditableStep[] = steps
    .flatMap((step) => [step, ...step.variants])
    .map((step) => ({
      key: `s${step.id}`,
      id: step.id,
      email_subject: step.email_subject ?? "",
      email_body: step.email_body ?? "",
      wait_in_days: step.wait_in_days ?? 0,
      thread_reply: Boolean(step.thread_reply),
      variant: Boolean(step.is_variant),
      // Not carried, exactly as the tool does not: the save payload sends
      // `variant_from_step_id: null`, and the route only forwards a truthy one.
    }));

  if (editing) {
    return (
      <SequenceEditor
        campaignId={campaignId}
        platform={platform}
        sequenceId={sequenceId}
        initial={editable}
        sentStepIds={sentStepIds}
        onDone={() => setEditing(false)}
        onSaved={onChanged}
        show={show}
      />
    );
  }

  /*
   * Copy, push, re-campaign and fan-out address campaigns by EmailBison's
   * integer id — their routes reject a uuid before doing anything — so on an
   * Instantly campaign they are offered disabled with the reason, rather than
   * offered live and failed after the click.
   */
  const ebOnly = platform !== "emailbison";
  const ebTitle = ebOnly ? "EmailBison campaigns only — this route addresses campaigns by EmailBison id" : undefined;
  const numericId = Number(campaignId);
  const stepCount = steps.filter((s) => !s.is_variant).length;

  const tools = (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
      <Btn onClick={() => setEditing(true)}>Edit sequence</Btn>
      <Btn disabled={ebOnly} title={ebTitle} onClick={() => setCopying(true)}>Copy sequence from…</Btn>
      {/* The other direction. This campaign's sequence is often the proven one,
          and rolling it out was previously only possible from an offer card —
          which meant creating an offer just to reuse a sequence. */}
      <Btn primary disabled={ebOnly || !steps.length} title={ebTitle} onClick={() => setPushing(true)}>Push to campaigns…</Btn>
      {/* Duplicate & re-campaign. Sits beside the sequence tools because that
          is what it copies — EmailBison's own duplicate carries the sequence
          and nothing else, which is the gap this closes. */}
      <Btn disabled={ebOnly} title={ebTitle} onClick={() => setReCampaigning(true)}>Re-campaign…</Btn>
      <Btn disabled={ebOnly} title={ebTitle} onClick={() => setFanningOut(true)}>For multiple clients…</Btn>
    </div>
  );

  const dialogs = ebOnly ? null : (
    <>
      <ReCampaignDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={reCampaigning}
        onOpenChange={setReCampaigning}
        onCreated={onChanged}
      />
      <FanOutDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={fanningOut}
        onOpenChange={setFanningOut}
        onCreated={onChanged}
      />
      <CopySequenceDialog
        targetId={numericId}
        targetName={campaignName}
        open={copying}
        onOpenChange={setCopying}
        onApplied={onChanged}
      />
      <PushSequenceDialog
        sourceId={numericId}
        sourceName={campaignName}
        // Steps only. A variant is an alternative wording at an existing
        // position, so counting it here overstates what gets pushed.
        stepCount={stepCount}
        open={pushing}
        onOpenChange={setPushing}
        onStart={deploy.start}
      />
    </>
  );

  if (!steps.length) {
    return (
      <>
        <Box title="The sequence" note="0 steps">
          <div style={{ padding: 22, display: "grid", gap: 14 }}>
            <div className="mut">
              This campaign has no sequence steps cached. Run sync-steps if it has one upstream, or
              copy a sequence from another campaign.
            </div>
            {tools}
          </div>
        </Box>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <BulkDeployPanel batch={deploy.batch} running={deploy.running} onRetry={deploy.retryFailed} onDismiss={deploy.dismiss} />
      {!varied ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>No copy variation.</b> Every recipient of this campaign gets a byte-identical email.
          Spintax — <code style={{ fontFamily: "var(--mono)" }}>{"{{Hi | Hello | Hey}}"}</code> —
          is what varies it.
        </div>
      ) : null}
      <div style={{ marginBottom: 14 }}>{tools}</div>
      {dialogs}
      <Box title="The sequence" note={`${steps.length} step${steps.length === 1 ? "" : "s"}`}>
        <div style={{ padding: "6px 0" }}>
          {steps.length === 0 ? (
            <div className="mut" style={{ padding: 22 }}>No steps in the cache for this campaign.</div>
          ) : (
            steps.map((s, i) => (
              <StepRow
                key={s.id}
                step={s}
                index={i}
                previousWait={i > 0 ? steps[i - 1].wait_in_days : null}
                open={open === s.id}
                onToggle={() => setOpen(open === s.id ? null : s.id)}
              />
            ))
          )}
        </div>
      </Box>
    </>
  );
}

function StepRow({
  step,
  index,
  previousWait,
  open,
  onToggle,
}: {
  step: Step;
  index: number;
  previousWait: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const st = step.stats;
  const varied = spintaxOf([{ email_body: step.email_body ?? "", email_subject: step.email_subject ?? "" }]).varied;

  return (
    <div style={{ borderTop: index ? "1px solid var(--line-soft)" : undefined }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left",
          border: 0, background: "none", padding: "14px 22px", cursor: "pointer", font: "inherit",
        }}
      >
        <span className="tile" style={{ width: 28, height: 28, fontSize: 12, fontWeight: 600 }}>
          {step.step_order}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {step.email_subject || "(no subject)"}
          </span>
          <span className="csince">
            {/*
              The wait shown is the PREVIOUS step's wait_in_days — that is what
              decides when this one goes out. The tool makes the same choice,
              and it is the difference between "sends after 1 day" and a number
              that describes the step after this one.
            */}
            {index === 0
              ? "sends immediately"
              : previousWait
                ? `after ${previousWait} day${previousWait === 1 ? "" : "s"}`
                : "same day"}
            {step.thread_reply ? " · replies in thread" : ""}
            {step.variants.length ? ` · ${step.variants.length} variant${step.variants.length === 1 ? "" : "s"}` : ""}
            {step.orphanedVariant ? " · orphaned variant" : ""}
          </span>
        </span>
        {varied ? <span className="badge s-done">spintax</span> : null}
        {st ? (
          <span className="tnum mut" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
            {fullNumber(st.sent)} sent · {fullNumber(st.replies)} replies · {fullNumber(st.bounced)} bounced
          </span>
        ) : null}
        <span aria-hidden style={{ color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div style={{ padding: "0 22px 20px" }}>
          <EmailPanel subject={step.email_subject} body={step.email_body} />
          {step.variants.map((v) => (
            <div key={v.id} style={{ marginTop: 12, paddingLeft: 18, borderLeft: "2px solid var(--line)" }}>
              <div className="csince" style={{ marginBottom: 6 }}>
                Variant {String.fromCharCode(65 + step.variants.indexOf(v))}
                {v.stats ? ` · ${fullNumber(v.stats.sent)} sent · ${fullNumber(v.stats.replies)} replies` : ""}
              </div>
              <EmailPanel subject={v.email_subject} body={v.email_body} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CopyAndOffer({
  campaignId,
  offerId,
  firstStep,
  isInstantly,
  show,
  onSaved,
}: {
  campaignId: string;
  offerId: string | null;
  firstStep: Step | null;
  isInstantly: boolean;
  show: (t: { text: string; bad?: boolean }) => void;
  onSaved: () => void;
}) {
  const offers = useAnalyticsData<{ offers: Array<{ id: string; name: string }> }>(
    "/api/tools/analytics/offers?preset=30d",
  );
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Box title="Offer" note="Which offer this campaign is selling. Offers are measured on the Copy & Offer screen.">
        <div style={{ padding: 22, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {isInstantly ? (
            <span className="mut">
              Offers attach to EmailBison campaigns — the mapping table keys on a bigint campaign
              id, and an Instantly uuid has nowhere to go in it.
            </span>
          ) : (
            <select
              className="sel"
              disabled={busy}
              value={offerId ?? ""}
              aria-label="Offer"
              style={{ minWidth: 280 }}
              onChange={async (e) => {
                setBusy(true);
                try {
                  await setCampaignOffer(campaignId, e.target.value || null);
                  onSaved();
                  show({ text: e.target.value ? "Offer set" : "Offer removed" });
                } catch (err) {
                  show({ text: err instanceof Error ? err.message : "Could not save", bad: true });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <option value="">No offer</option>
              {(offers.data?.offers ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </div>
      </Box>

      {/*
        The seven copy dimensions for the opening email — see copy-tags-panel.tsx,
        which the sequence editor shares. FIRST EMAIL ONLY is measured, and
        Instantly steps have no `sequence_steps` row for a tag to hang on.
      */}
      {firstStep && !isInstantly ? (
        <CopyTagsPanel stepId={firstStep.id} subject={firstStep.email_subject} show={show} />
      ) : null}
    </>
  );
}

function Settings({
  campaign: c,
  show,
  onSaved,
}: {
  campaign: Campaign;
  show: (t: { text: string; bad?: boolean }) => void;
  onSaved: () => void;
}) {
  const initial: CampaignSettingsPatch = {
    name: c.name,
    max_emails_per_day: c.max_emails_per_day ?? undefined,
    max_new_leads_per_day: c.max_new_leads_per_day ?? undefined,
    plain_text: c.plain_text ?? false,
    open_tracking: c.open_tracking ?? false,
    can_unsubscribe: c.can_unsubscribe ?? false,
    include_auto_replies_in_stats: c.include_auto_replies_in_stats ?? false,
  };
  const [draft, setDraft] = useState<CampaignSettingsPatch>(initial);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const capConflict =
    draft.max_emails_per_day != null &&
    draft.max_new_leads_per_day != null &&
    draft.max_emails_per_day < draft.max_new_leads_per_day;

  const set = (patch: Partial<CampaignSettingsPatch>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Box
      title="Settings"
      note="Written to EmailBison first. The local cache is updated only after EmailBison accepts, so this can never show a change as saved when it was not."
      right={
        <>
          {dirty ? <span className="badge s-ok">Unsaved changes</span> : <span className="badge s-done">Saved</span>}
          <Btn
            primary
            disabled={busy || !dirty || capConflict}
            onClick={async () => {
              setBusy(true);
              try {
                // Only the CHANGED keys, because EmailBison defaults an omitted
                // boolean to false — sending the whole object would silently
                // turn off anything this form does not show.
                const patch: CampaignSettingsPatch = {};
                for (const key of Object.keys(draft) as Array<keyof CampaignSettingsPatch>) {
                  if (draft[key] !== initial[key]) {
                    (patch as Record<string, unknown>)[key] = draft[key];
                  }
                }
                await saveCampaignSettings(String(c.id), patch);
                onSaved();
                show({ text: "Saved to EmailBison" });
              } catch (e) {
                show({ text: e instanceof Error ? e.message : "EmailBison refused the change", bad: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save changes
          </Btn>
        </>
      }
    >
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div className="card-l">Name</div>
          <input
            className="inp"
            value={draft.name ?? ""}
            disabled={busy}
            onChange={(e) => set({ name: e.target.value })}
            style={{ width: "100%", maxWidth: 520 }}
          />
          <div className="csince" style={{ marginTop: 6 }}>
            The client is matched from this name. Renaming a campaign can reassign it.
          </div>
        </div>

        <div>
          <div className="card-l">Sending limits</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={{ display: "block" }}>
              <span className="as-l">Emails per day</span>
              <input
                className="inp" type="number" min={0} disabled={busy}
                value={draft.max_emails_per_day ?? ""}
                onChange={(e) => set({ max_emails_per_day: e.target.value === "" ? undefined : Number(e.target.value) })}
                style={{ minWidth: 150 }}
              />
            </label>
            <label style={{ display: "block" }}>
              <span className="as-l">New leads per day</span>
              <input
                className="inp" type="number" min={0} disabled={busy}
                value={draft.max_new_leads_per_day ?? ""}
                onChange={(e) => set({ max_new_leads_per_day: e.target.value === "" ? undefined : Number(e.target.value) })}
                style={{ minWidth: 150 }}
              />
            </label>
          </div>
          {capConflict ? (
            <div style={{ marginTop: 8, color: "var(--red)", fontSize: 12.5 }}>
              The daily email cap is below the new-lead cap, so leads would be contacted more
              slowly than they are added. EmailBison rejects this.
            </div>
          ) : null}
        </div>

        <div>
          <div className="card-l">Content and tracking</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {([
              ["plain_text", "Plain text"],
              ["open_tracking", "Open tracking"],
              ["can_unsubscribe", "Unsubscribe link"],
              ["include_auto_replies_in_stats", "Count auto-replies in stats"],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={Boolean(draft[key])}
                  style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                  onChange={(e) => set({ [key]: e.target.checked } as Partial<CampaignSettingsPatch>)}
                />
                {label}
              </label>
            ))}
          </div>
          {c.unsubscribe_text ? (
            <div className="csince" style={{ marginTop: 10 }}>
              Unsubscribe wording (read-only, set in EmailBison): {c.unsubscribe_text}
            </div>
          ) : null}
        </div>
      </div>
    </Box>
  );
}

function ActivityLog({ rows }: { rows: Activity[] }) {
  return (
    <Box title="Activity" note="Every change this workspace or the tool has made to this campaign.">
      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 780 }}>
          <thead>
            <tr>
              <th style={{ width: 170 }}>When</th>
              <th style={{ width: 160 }}>Action</th>
              <th style={{ width: 220 }}>Who</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={4}>Nothing has changed this campaign.</EmptyRow>
            ) : (
              rows.map((a) => (
                <tr key={a.id}>
                  <td className="mut" style={{ fontSize: 12.5 }}>{fullStamp(a.created_at)}</td>
                  <td>{a.action}</td>
                  <td className="mut">{a.actor ?? DASH}</td>
                  <td>
                    <span className={`badge ${a.status === "ok" ? "s-done" : "s-risk"}`}>{a.status}</span>
                    {a.error ? <span style={{ color: "var(--red)", marginLeft: 8 }}>{a.error}</span> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Box>
  );
}
