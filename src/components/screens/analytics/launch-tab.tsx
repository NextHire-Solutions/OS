"use client";

import { useState } from "react";

import type { LaunchCheck, LaunchFacts, LaunchVerdict } from "@/lib/tools/analytics/campaigns/launch.ts";

import { CAMPAIGN_LAUNCH_URL, launchCampaign, useAnalyticsData } from "./actions";
import { Box, LoadError } from "./shared";
import { Btn, ConfirmButton } from "./toast";

/*
 * The Launch tab on one campaign (13 Oct — OS feedback: "Add a launch tab to a
 * single campaign").
 *
 * A campaign built here (fanned out, re-campaigned) lands as a DRAFT, and
 * until now a draft could only be started in EmailBison. This tab starts it —
 * and a paused one — after showing what it is about to do: the checks are read
 * live from EmailBison when the tab opens, and run again on the server when
 * the button is pressed. The rules are in campaigns/launch.ts.
 *
 * The button is two-step (it arms, then confirms) for the same reason Resume
 * is: this is the action that emails real people, and it is not an undo.
 */

interface LaunchResponse {
  name: string;
  facts: LaunchFacts;
  verdict: LaunchVerdict;
  summary: string | null;
}

const TONE: Record<LaunchCheck["state"], { mark: string; color: string; word: string }> = {
  ok: { mark: "✓", color: "var(--green)", word: "Ready" },
  warn: { mark: "!", color: "var(--yellow, #B7791F)", word: "Check" },
  blocked: { mark: "✗", color: "var(--red)", word: "Missing" },
  unknown: { mark: "?", color: "var(--muted)", word: "Not checked" },
};

export function LaunchTab({
  campaignId,
  show,
  onLaunched,
}: {
  campaignId: string;
  show: (t: { text: string; bad?: boolean }) => void;
  onLaunched: () => void;
}) {
  const { data, error, loading, reload } = useAnalyticsData<LaunchResponse>(CAMPAIGN_LAUNCH_URL(campaignId));
  const [working, setWorking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (error && !data) return <LoadError what="The launch checks" error={error} />;
  if (!data) return <div className="mut" data-launch="loading">Checking this campaign against EmailBison…</div>;

  const { verdict, summary } = data;
  const verb = verdict.action === "resume" ? "Resume" : "Launch";

  async function go() {
    setWorking(true);
    setRefused(null);
    try {
      const out = await launchCampaign(campaignId);
      show({ text: `${verb === "Resume" ? "Resumed" : "Launched"} — ${out.status ?? "queued"} to send` });
      onLaunched();
      await reload();
    } catch (e) {
      // The server's own sentence: which check failed, or what EmailBison said.
      const message = e instanceof Error ? e.message : `${verb} failed`;
      setRefused(message);
      show({ text: message, bad: true });
      await reload();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div data-launch={verdict.can ? "ready" : verdict.action ? "blocked" : "none"} style={{ opacity: loading ? 0.7 : 1, transition: "opacity .14s" }}>
      <Box
        title="Before it sends"
        note="Read from EmailBison just now."
        right={<Btn disabled={loading || working} onClick={() => void reload()}>Check again</Btn>}
      >
        <div style={{ padding: "6px 22px 10px" }}>
          {verdict.checks.map((c) => {
            const t = TONE[c.state];
            return (
              <div
                key={c.key}
                data-launch-check={c.key}
                data-state={c.state}
                style={{ display: "grid", gridTemplateColumns: "22px minmax(110px, 170px) minmax(0, 1fr)", gap: 10, alignItems: "baseline", padding: "9px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13 }}
              >
                <span aria-hidden style={{ color: t.color, fontWeight: 700 }}>{t.mark}</span>
                <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                  {c.label}
                  <span className="mut" style={{ fontWeight: 400 }}> · {t.word}</span>
                </span>
                <span style={{ color: c.state === "blocked" ? "var(--red)" : "var(--ink-2)", lineHeight: 1.5 }}>{c.detail}</span>
              </div>
            );
          })}
        </div>
      </Box>

      <Box title={verdict.action ? `${verb} this campaign` : "Nothing to launch"}>
        <div style={{ padding: 22, display: "grid", gap: 14 }}>
          {verdict.can && summary ? (
            <>
              <div data-launch-summary style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>{summary}</div>
              <div>
                <ConfirmButton
                  primary
                  label={working ? "Working…" : `${verb} campaign`}
                  armedLabel={`Confirm ${verb.toLowerCase()} — starts sending`}
                  title={`${verb} queues this campaign to SEND to its leads. It can be paused, not undone.`}
                  disabled={working || loading}
                  onConfirm={() => void go()}
                />
              </div>
            </>
          ) : (
            <div data-launch-reason style={{ fontSize: 13.5, lineHeight: 1.55, color: verdict.action ? "var(--red)" : "var(--ink-2)" }}>
              {verdict.reason}
              {verdict.action ? <div className="mut" style={{ marginTop: 6 }}>Fix what is marked above, then press Check again.</div> : null}
            </div>
          )}
          {refused ? (
            <div
              role="alert"
              style={{ border: "1px solid var(--red)", background: "var(--red-bg)", color: "var(--red)", borderRadius: "var(--r-md)", padding: "8px 10px", fontSize: 12.5 }}
            >
              {refused}
            </div>
          ) : null}
        </div>
      </Box>
    </div>
  );
}
