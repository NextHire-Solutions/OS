"use client";

import { useCallback, useState } from "react";

import { applyCopySequence, type CopyMode } from "./actions";
import { Btn } from "./toast";

/*
 * Pushing one sequence into many campaigns — the tool's
 * `components/analytics/bulk-deploy.tsx`.
 *
 * Every task is a separate write to EmailBison against a live campaign, so this
 * is built around the assumption that some of them WILL fail — a target whose
 * steps have already sent cannot be replaced, and a campaign deleted upstream
 * cannot be written to at all. The shape follows from that:
 *
 *  - RUN THEM ONE AT A TIME. Concurrency would finish sooner and would also
 *    mean several half-applied sequences at once when the API starts refusing.
 *    Serial keeps every failure isolated and the audit log readable.
 *  - NEVER STOP THE BATCH ON A FAILURE. One target refusing says nothing about
 *    the next; stopping would turn one bad campaign into thirty unattempted.
 *  - KEEP THE REAL ERROR PER TARGET. A count of failures is not actionable —
 *    "this one has already sent" and "this one no longer exists" need different
 *    responses, and the panel shows each verbatim.
 *  - RETRY ONLY WHAT FAILED. Re-running the successes would append the sequence
 *    a second time, which is silent duplication rather than a no-op.
 */

export type TaskStatus = "pending" | "running" | "ok" | "error";

export interface DeployTask {
  campaignId: number;
  name: string;
  status: TaskStatus;
  error?: string;
  created?: number;
  deleted?: number;
  /** True when a partial write left the campaign without a sequence. */
  leftEmpty?: boolean;
}

export interface DeployBatch {
  sourceCampaignId: number;
  sourceLabel: string;
  mode: CopyMode;
  tasks: DeployTask[];
}

async function runOne(
  sourceCampaignId: number,
  mode: CopyMode,
  targetId: number,
): Promise<Partial<DeployTask>> {
  const { ok, status, body } = await applyCopySequence(targetId, sourceCampaignId, mode, {
    includeVariants: true,
    includeAttachments: true,
  });
  if (!ok) {
    return {
      status: "error",
      error: body.error ?? `Request failed (${status})`,
      leftEmpty: Boolean(body.targetLeftEmpty),
    };
  }
  return { status: "ok", created: body.created ?? 0, deleted: body.deleted ?? 0 };
}

/** `onSettled` is the tool's query invalidation: the caller reloads the campaign. */
export function useBulkDeploy(onSettled?: () => void) {
  const [batch, setBatch] = useState<DeployBatch | null>(null);
  const [running, setRunning] = useState(false);

  const process = useCallback(
    async (current: DeployBatch, only?: number[]) => {
      setRunning(true);
      const targets = current.tasks.filter(
        (t) => (only ? only.includes(t.campaignId) : true) && t.status !== "ok",
      );

      for (const task of targets) {
        setBatch((b) =>
          b
            ? {
                ...b,
                tasks: b.tasks.map((t) =>
                  t.campaignId === task.campaignId ? { ...t, status: "running", error: undefined } : t,
                ),
              }
            : b,
        );

        let result: Partial<DeployTask>;
        try {
          result = await runOne(current.sourceCampaignId, current.mode, task.campaignId);
        } catch (error) {
          // A network failure is not a refusal — say so, and leave it retryable.
          result = { status: "error", error: error instanceof Error ? error.message : "Network error" };
        }

        setBatch((b) =>
          b
            ? { ...b, tasks: b.tasks.map((t) => (t.campaignId === task.campaignId ? { ...t, ...result } : t)) }
            : b,
        );
      }

      setRunning(false);
      onSettled?.();
    },
    [onSettled],
  );

  const start = useCallback(
    (next: DeployBatch) => {
      setBatch(next);
      void process(next);
    },
    [process],
  );

  const retryFailed = useCallback(() => {
    if (!batch) return;
    const failed = batch.tasks.filter((t) => t.status === "error").map((t) => t.campaignId);
    if (failed.length) void process(batch, failed);
  }, [batch, process]);

  return { batch, running, start, retryFailed, dismiss: () => setBatch(null) };
}

/** The panel. Sticky at the top of the page while a batch runs. */
export function BulkDeployPanel({
  batch,
  running,
  onRetry,
  onDismiss,
}: {
  batch: DeployBatch | null;
  running: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (!batch) return null;

  const done = batch.tasks.filter((t) => t.status === "ok").length;
  const failed = batch.tasks.filter((t) => t.status === "error");
  const total = batch.tasks.length;
  const pct = Math.round(((done + failed.length) / total) * 100);

  return (
    <section
      className="abox"
      style={{ position: "sticky", top: 0, zIndex: 20, marginBottom: 16 }}
      role="status"
      aria-live="polite"
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-soft)" }}>
        <span
          className={`badge ${running ? "s-pending" : failed.length ? "s-risk" : "s-done"}`}
          style={{ flex: "none" }}
        >
          {running ? "Copying" : failed.length ? "Finished with errors" : "Copied"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            &ldquo;{batch.sourceLabel}&rdquo; to {total} {total === 1 ? "campaign" : "campaigns"}
          </div>
          <div className="tnum mut" style={{ fontSize: 12 }}>
            {done} succeeded
            {failed.length ? ` · ${failed.length} failed` : ""}
            {running ? ` · ${total - done - failed.length} remaining` : ""} · {batch.mode}
          </div>
        </div>
        {!running && failed.length ? <Btn onClick={onRetry}>Retry {failed.length} failed</Btn> : null}
        {!running ? <Btn onClick={onDismiss} aria-label="Dismiss">Dismiss</Btn> : null}
      </div>

      <div className="bar-h" style={{ height: 4, borderRadius: 0 }}>
        <i style={{ width: `${pct}%`, background: failed.length ? "var(--red)" : "var(--green)" }} />
      </div>

      {/* Only the failures get listed. Thirty green rows push the two that need
          a human off the screen, which defeats the panel. */}
      {failed.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 224, overflowY: "auto" }}>
          {failed.map((task) => (
            <li key={task.campaignId} style={{ padding: "8px 16px", borderTop: "1px solid var(--line-soft)", fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={task.name}>
                {task.name}
              </div>
              <div style={{ color: "var(--red)" }}>{task.error}</div>
              {task.leftEmpty ? (
                <div style={{ color: "var(--red)", fontWeight: 600 }}>
                  This campaign now has NO sequence — its previous steps are in its Activity tab.
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {running ? (
        <div className="mut" style={{ padding: "8px 16px", fontSize: 12 }}>
          {/* Says why it is not instant, so a slow batch does not read as a hang. */}
          Run one at a time so a failure never leaves several campaigns half-written.
        </div>
      ) : null}
    </section>
  );
}
