"use client";

import { useState } from "react";

import { renderName } from "@/lib/tools/analytics/campaigns/fan-out-name.ts";
import { fullNumber } from "@/lib/tools/analytics/format.ts";
import { CAMPAIGNS_URL, fanOut, useAnalyticsData, type FanOutSummary } from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Check, Search } from "./shared";
import { Btn } from "./toast";

/*
 * Build one campaign per client from this one — the tool's
 * `components/campaigns/fan-out-dialog.tsx`.
 *
 * The preview line is the part that matters: it shows the ACTUAL name the first
 * selected client would get, rendered by the same function the server uses. A
 * template with a typo, or one that would produce identical names, is visible
 * before anything is created rather than after five campaigns exist.
 */
export function FanOutDialog({
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
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [template, setTemplate] = useState("");
  const [copyInboxes, setCopyInboxes] = useState(true);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<FanOutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The client roster rides along on the campaign list, as the tool reads it.
  const clientQuery = useAnalyticsData<{ clients: Array<{ id: string; name: string }> }>(
    CAMPAIGNS_URL("status=all&limit=1"),
    { skip: !open },
  );
  const clients = clientQuery.data?.clients ?? [];
  const visible = search ? clients.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())) : clients;

  // Derived, not seeded, so it is correct however the dialog was opened.
  const effectiveTemplate = template || `{client} — ${campaignName}`;
  const firstChosen = clients.find((c) => chosen.has(c.id));
  const previewName = firstChosen ? renderName(effectiveTemplate, firstChosen.name) : "";

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setSummary(await fanOut(campaignId, { clientIds: [...chosen], nameTemplate: effectiveTemplate, copyInboxes }));
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the campaigns.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setSummary(null);
      setError(null);
      setChosen(new Set());
    }, 200);
  };

  return (
    <DialogFrame
      open={open}
      onClose={running ? () => {} : close}
      width={600}
      title={summary ? "Campaigns created" : "Create for multiple clients"}
      footer={
        summary ? (
          <Btn primary onClick={close}>Close</Btn>
        ) : (
          <>
            <Btn onClick={close} disabled={running}>Cancel</Btn>
            <Btn primary onClick={() => void run()} disabled={running || chosen.size === 0}>
              {running ? "Creating…" : `Create ${chosen.size ? fullNumber(chosen.size) : ""} campaign${chosen.size === 1 ? "" : "s"}`}
            </Btn>
          </>
        )
      }
    >
      {summary ? (
        <>
          <p className="tnum" style={{ margin: 0 }}>
            <b>{fullNumber(summary.created)}</b> campaign{summary.created === 1 ? "" : "s"} created
            {summary.failed ? `, ${fullNumber(summary.failed)} failed` : ""}.
          </p>
          <Panel style={{ maxHeight: 224, overflowY: "auto", fontSize: 12.5, display: "grid", gap: 4 }}>
            {summary.targets.map((t) => (
              <div key={t.clientName} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ color: t.ok ? "var(--green)" : "var(--red)", flex: "none" }}>{t.ok ? "✓" : "✗"}</span>
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span className="tnum mut" style={{ flex: "none" }}>
                  {t.ok ? `${t.steps} steps · ${fullNumber(t.inboxes)} inboxes` : t.error}
                </span>
              </div>
            ))}
          </Panel>
          <Warn>
            <b>They are drafts with no leads.</b> Add each client&rsquo;s leads, then start them from the Campaigns page.
          </Warn>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            Copies this campaign&rsquo;s sequence into a new campaign for each client you pick, so the
            same setup does not have to be built by hand for each one.
          </p>

          <label style={{ display: "block" }}>
            <span className="as-l">Name for each campaign</span>
            <input className="inp" value={effectiveTemplate} onChange={(e) => setTemplate(e.target.value)} style={{ width: "100%" }} />
            <span className="csince">
              <code style={{ fontFamily: "var(--mono)" }}>{"{client}"}</code> is replaced with each client&rsquo;s name.
              {previewName ? (
                <> First one would be <b style={{ color: "var(--ink)" }}>{previewName}</b>.</>
              ) : null}
            </span>
          </label>

          <Search value={search} onChange={setSearch} placeholder="Search clients…" width={300} />

          <div style={{ maxHeight: 224, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 4 }}>
            {clientQuery.error ? (
              <Fail>{clientQuery.error}</Fail>
            ) : !clientQuery.data ? (
              <div className="mut" style={{ padding: 16, textAlign: "center", fontSize: 12.5 }}>Loading clients…</div>
            ) : visible.length === 0 ? (
              <div className="mut" style={{ padding: 16, textAlign: "center", fontSize: 12.5 }}>No clients match</div>
            ) : (
              visible.map((c) => (
                <label
                  key={c.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                    fontSize: 13, fontWeight: chosen.has(c.id) ? 600 : 400, background: chosen.has(c.id) ? "var(--blue-pale)" : undefined,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    style={{ accentColor: "var(--blue)" }}
                  />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </label>
              ))
            )}
          </div>

          <Check checked={copyInboxes} onChange={setCopyInboxes} label={`Give each one the same inboxes as ${campaignName}.`} />

          <Warn>
            {/* Said plainly because it is the one thing someone might assume
                otherwise: these clients have different audiences, so copying
                the template's leads would mail one client's list under
                another's name. */}
            Each campaign is created as a <b>draft with no leads</b> — the sequence and inboxes are
            copied, the audience is not. Add each client&rsquo;s own leads before starting them.
          </Warn>
        </>
      )}
      {error ? <Fail>{error}</Fail> : null}
    </DialogFrame>
  );
}
