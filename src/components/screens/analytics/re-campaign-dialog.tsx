"use client";

import { useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import { RECAMPAIGN_PREVIEW_URL, reCampaign, useAnalyticsData, type ReCampaignResult } from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Check } from "./shared";
import { Btn } from "./toast";

/*
 * Duplicate a campaign and load it with the people who never answered — the
 * tool's `components/campaigns/re-campaign-dialog.tsx`.
 *
 * The dialog's real job is the two numbers. "5,982 never replied" is the
 * interesting fact; "1,177 can actually be moved" is what will happen, and the
 * gap between them is not an error — it is everyone still being emailed by
 * another campaign, whom EmailBison rightly refuses to double-sequence.
 * Showing only one of the two either promises a move that will not happen or
 * makes it look like leads went missing.
 */

interface Preview {
  unresponsive: number;
  available: number;
  /** Bounced leads still attached to the source campaign. */
  bounced: number;
}

export function ReCampaignDialog({
  campaignId,
  campaignName,
  open,
  onOpenChange,
  onCreated,
}: {
  campaignId: string;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tool's `invalidateQueries(["campaigns"])`. */
  onCreated: () => void;
}) {
  // Empty means "not typed in yet"; the default is DERIVED during render
  // rather than seeded, so it is right however the dialog was opened.
  const [name, setName] = useState("");
  const [copyInboxes, setCopyInboxes] = useState(true);
  // Off by default: the only step here that changes the ORIGINAL campaign, and
  // EmailBison cannot put a removed lead back.
  const [removeBounced, setRemoveBounced] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Partial<ReCampaignResult> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewQuery = useAnalyticsData<Preview>(RECAMPAIGN_PREVIEW_URL(campaignId), { skip: !open });
  const preview = previewQuery.data;

  const effectiveName = name || `${campaignName} — follow-up`;
  const available = preview?.available ?? 0;
  const blocked = (preview?.unresponsive ?? 0) - available;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { ok, status, body } = await reCampaign(campaignId, {
        name: effectiveName.trim(),
        copyInboxes,
        removeBouncedFromSource: removeBounced,
      });
      if (!ok && status !== 207) {
        setError(body.error ?? "Could not create the campaign.");
        if (body.campaignId) setResult(body);
        return;
      }
      setResult(body);
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the campaign.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setResult(null);
      setError(null);
    }, 200);
  };

  return (
    <DialogFrame
      open={open}
      onClose={running ? () => {} : close}
      width={540}
      title={result ? "Re-campaign finished" : "Duplicate & re-campaign"}
      footer={
        result ? (
          <Btn primary onClick={close}>Close</Btn>
        ) : (
          <>
            <Btn onClick={close} disabled={running}>Cancel</Btn>
            <Btn primary onClick={() => void run()} disabled={running || !effectiveName.trim() || available === 0}>
              {running ? "Creating…" : `Create draft${available ? ` · up to ${fullNumber(available)} leads` : ""}`}
            </Btn>
          </>
        )
      }
    >
      {result ? (
        result.campaignId ? (
          <>
            <p className="tnum" style={{ margin: 0 }}>
              Created <b>{result.name}</b> with {fullNumber(result.steps)} sequence step{result.steps === 1 ? "" : "s"},{" "}
              {fullNumber(result.inboxes)} inbox{result.inboxes === 1 ? "" : "es"} and <b>{fullNumber(result.leadsAttached)}</b> leads.
            </p>
            {(result.bouncedRemoved ?? 0) > 0 ? (
              <p className="tnum mut" style={{ margin: 0, fontSize: 12.5 }}>
                {fullNumber(result.bouncedRemoved)} bounced lead{result.bouncedRemoved === 1 ? "" : "s"} removed from {campaignName}.
              </p>
            ) : null}
            {(result.leadsSkipped ?? 0) > 0 ? (
              <p className="tnum mut" style={{ margin: 0, fontSize: 12.5 }}>
                {fullNumber(result.leadsSkipped)} of the {fullNumber(result.leadsSelected)} selected were refused — still being
                emailed elsewhere, bounced, or unsubscribed.
              </p>
            ) : null}
            <Warn>
              {/* The most important line in the dialog. The campaign exists
                  and is loaded, and does nothing at all until someone starts
                  it — a separate decision this feature deliberately does not make. */}
              <b>It is a draft and is not sending.</b> Review the sequence and the leads, then start it
              from the Campaigns page when you are ready.
            </Warn>
          </>
        ) : (
          <p style={{ margin: 0 }}>
            {result.error}
            {result.rolledBack ? <span className="mut"> The empty duplicate was deleted, so nothing was left behind.</span> : null}
          </p>
        )
      ) : (
        <>
          <p style={{ margin: 0 }}>
            Copies this campaign&rsquo;s sequence into a new campaign and adds the leads who never replied,
            so they can be sequenced again.
          </p>

          {previewQuery.error ? (
            <Fail>{previewQuery.error}</Fail>
          ) : !preview ? (
            <div className="mut">Counting leads…</div>
          ) : (
            <Panel style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <div className="tnum" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Never replied on this campaign</span>
                <b>{fullNumber(preview.unresponsive)}</b>
              </div>
              <div className="tnum mut" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Still being emailed elsewhere</span>
                <span>−{fullNumber(blocked)}</span>
              </div>
              <div className="tnum" style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--line-soft)", paddingTop: 4, fontWeight: 600 }}>
                <span>Can be moved</span>
                <span>up to {fullNumber(available)}</span>
              </div>
            </Panel>
          )}

          {blocked > 0 ? (
            <p className="mut" style={{ margin: 0, fontSize: 12.5 }}>
              {/* Explained rather than just subtracted. This is EmailBison
                  protecting people from two sequences at once, not a failure. */}
              EmailBison will not add a lead who is part-way through another campaign&rsquo;s sequence, so
              those are left out. The final count is confirmed against EmailBison after the move.
            </p>
          ) : null}

          <label style={{ display: "block" }}>
            <span className="as-l">New campaign name</span>
            <input className="inp" value={effectiveName} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
          </label>

          <Check checked={copyInboxes} onChange={setCopyInboxes} label={`Use the same inboxes as ${campaignName}.`} hint="A campaign with no inboxes cannot send." />

          {/* Offered only when there is something to clean. A checkbox that
              would do nothing is worse than no checkbox. */}
          {(preview?.bounced ?? 0) > 0 ? (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, cursor: "pointer" }}>
              <input type="checkbox" checked={removeBounced} onChange={(e) => setRemoveBounced(e.target.checked)} style={{ accentColor: "var(--blue)", marginTop: 2 }} />
              <span className="tnum">
                Also remove the <b>{fullNumber(preview?.bounced)} bounced</b> lead{preview?.bounced === 1 ? "" : "s"} from {campaignName}.{" "}
                <span className="mut">
                  They have already refused delivery and will refuse every remaining step. This changes the
                  original campaign and cannot be undone.
                </span>
              </span>
            </label>
          ) : null}

          <Warn>
            The new campaign is created as a <b>draft</b> and sends nothing until you start it. The leads
            stay on {campaignName} too — nothing is removed.
          </Warn>
        </>
      )}
      {error && !result?.campaignId ? <Fail>{error}</Fail> : null}
    </DialogFrame>
  );
}
