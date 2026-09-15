"use client";

import { useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import { removeLeads, type RemoveLeadsResult } from "./actions";
import { DialogFrame, Fail, Warn } from "./dialog-frame";
import { Btn } from "./toast";

/*
 * Confirming the removal of leads from a campaign — the tool's
 * `components/campaigns/remove-leads-dialog.tsx`.
 *
 * This is the only destructive write in the product that cannot be undone:
 * pause has resume, and a sequence can be pushed again, but EmailBison offers
 * no "restore removed leads" call. Re-adding them is a separate deliberate act
 * against a list you would have to reconstruct yourself.
 *
 * So the dialog's job is to make the count real before the click, and to report
 * what actually happened after it — including the case where EmailBison accepts
 * fewer than were asked for, which it does silently.
 */
export function RemoveLeadsDialog({
  campaignId,
  campaignName,
  platformName,
  leadIds,
  open,
  onOpenChange,
  onDone,
}: {
  /** Text: an EmailBison bigint or an Instantly uuid. */
  campaignId: string;
  campaignName: string;
  platformName: string;
  /*
   * Integers for EmailBison, uuid strings for Instantly. Passed through as
   * they came rather than coerced — the route refuses a list whose ids do not
   * match the campaign's platform, and coercing here would defeat that check.
   */
  leadIds: Array<number | string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RemoveLeadsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const body = await removeLeads(campaignId, leadIds);
      setResult(body);
      /*
       * Refetch rather than patch the cache: the row count, the status facets
       * and the paging all move together, and a hand-patched list would drift
       * from the server's idea of the page.
       */
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The removal failed.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    // Cleared on close, not on open, so the summary stays readable while the
    // dialog is being dismissed.
    setTimeout(() => {
      setResult(null);
      setError(null);
    }, 200);
  };

  return (
    <DialogFrame
      open={open}
      onClose={running ? () => {} : close}
      width={520}
      title={result ? "Removal finished" : `Remove ${fullNumber(leadIds.length)} leads?`}
      footer={
        result ? (
          <Btn primary onClick={close}>Close</Btn>
        ) : (
          <>
            <Btn onClick={close} disabled={running}>Cancel</Btn>
            <Btn
              disabled={running}
              onClick={() => void run()}
              style={{ color: "#fff", background: "var(--red)", borderColor: "var(--red)" }}
            >
              {running ? "Removing…" : `Remove ${fullNumber(leadIds.length)}`}
            </Btn>
          </>
        )
      }
    >
      {result ? (
        <>
          <p className="tnum" style={{ margin: 0 }}>
            <b>{fullNumber(result.applied)}</b> {result.applied === 1 ? "lead was" : "leads were"} removed from {campaignName}.
          </p>
          {/*
            Reported because EmailBison does not report it. It answers an
            attach with success while silently dropping leads it will not
            accept, and refuses a removal outright if an id is already
            gone — so "asked for 500, removed 480" is a real outcome and
            saying only "done" would be a lie of omission.
          */}
          {result.skipped > 0 ? (
            <p className="tnum mut" style={{ margin: 0 }}>
              {fullNumber(result.skipped)} of the {fullNumber(result.attempted)} selected{" "}
              {result.skipped === 1 ? "was" : "were"} already off this campaign, so nothing changed for{" "}
              {result.skipped === 1 ? "it" : "them"}.
            </p>
          ) : null}
          {(result.chunks ?? []).some((c) => !c.ok) ? (
            <Warn>
              <b>Some of it did not go through:</b>
              {result.chunks.filter((c) => !c.ok).slice(0, 3).map((c, i) => (
                <div key={i}>{fullNumber(c.size)} leads — {c.error}</div>
              ))}
            </Warn>
          ) : null}
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            This removes them from <b>{campaignName}</b> in {platformName}. They stop receiving the rest of the sequence.
          </p>
          <Warn>
            {/*
              Both halves matter. "Cannot be undone" is the warning;
              "history is kept" stops someone believing this rewrites
              the campaign's past and hesitating over the wrong risk.
            */}
            <b>There is no undo.</b> {platformName} has no way to restore removed leads. Emails
            already sent are kept, so this campaign&rsquo;s past numbers do not change — the leads
            simply stop receiving anything further.
          </Warn>
          <p className="mut" style={{ margin: 0, fontSize: 12.5 }}>
            The leads themselves are not deleted, and stay in any other campaign they belong to.
          </p>
        </>
      )}
      {error ? <Fail>{error}</Fail> : null}
    </DialogFrame>
  );
}
