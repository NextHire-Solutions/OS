"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Switch } from "@/components/mi-ui/switch";
import type { BrokerageRow, RelayOverview } from "@/lib/tools/master-inbox/relay/relay";
import type { PipelineEntry, RecipientMode, RelayMode } from "@/lib/tools/master-inbox/relay/settings";
import { REASON_TEXT, relayLine, stamp } from "@/lib/tools/master-inbox/relay/wording";
import { MAX_TEST_RECIPIENTS } from "@/lib/tools/master-inbox/relay/test-send";

import { RelayEmailButton } from "./relay-email-view";
import { Btn, ConfirmButton, Field, Section, ToastHost, ToggleRow, useShowToast } from "./ui";

/*
 * Inbox → Settings → Brokerage hand-off (admins). The relay's switches, the
 * campaigns waiting for the team, each brokerage's own settings and the log.
 *
 * Every change is a PUT/POST the server validates again (relay/settings.ts);
 * the server's own locks — OS_BROKERAGE_RELAY_LIVE_SEND and the Postmark token
 * — are shown, never changeable from here.
 */

async function send(url: string, method: "PUT" | "POST", body: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { ...json, ok: res.ok, error: res.ok ? undefined : json.error ?? `Failed (${res.status})` };
}

export function BrokerageRelaySettings({ initial }: { initial: RelayOverview }) {
  return (
    <ToastHost>
      {/* Keyed by version: after a refresh the form shows what is stored now, never the values this tab loaded. */}
      <Panel key={initial.settings.updatedAt ?? "new"} data={initial} />
    </ToastHost>
  );
}

function Panel({ data }: { data: RelayOverview }) {
  const router = useRouter();
  const show = useShowToast();
  const s = data.settings;
  const [enabled, setEnabled] = useState(s.enabled);
  const [practice, setPractice] = useState(s.practiceMode);
  const [mode, setMode] = useState<RelayMode>(s.mode);
  const [cap, setCap] = useState(String(s.hourlyCap));
  const [later, setLater] = useState(s.forwardLaterReplies);
  const [countsIntro, setCountsIntro] = useState(s.countsAsIntroduction);
  const [busy, setBusy] = useState(false);

  if (!data.available) {
    return (
      <>
        <Section title="Not set up yet">
          <p className="mut">
            Run migration <b>0035_brokerage_relay.sql</b> (and 0036) in the Master Inbox database first. Until then the hand-off does
            nothing at all.
          </p>
        </Section>
        <TestSends tokenSet={data.server.tokenSet} tests={data.tests} />
      </>
    );
  }

  const pilots = data.brokerages.filter((b) => b.relay.enabled);
  const leavingPractice = s.practiceMode && !practice;
  const state = !s.enabled
    ? "Off — nothing is decided or sent."
    : s.practiceMode
      ? "Practice — every Interested reply is checked and recorded with the email it would send. Nothing is sent."
      : !data.server.liveSendAllowed || !data.server.tokenSet
        ? "Practice on this server — Settings allow sending, but the server's own lock is closed, so nothing is sent."
        : `Live for ${pilots.length} brokerage${pilots.length === 1 ? "" : "s"}${pilots.length ? ` (${pilots.map((b) => b.name).join(", ")})` : ""}; practice for the rest.`;

  const save = async () => {
    // Only what was changed here, and the version it was changed from: the server refuses if someone saved since (21 Oct review).
    const changed: Record<string, unknown> = {};
    if (enabled !== s.enabled) changed.enabled = enabled;
    if (practice !== s.practiceMode) changed.practiceMode = practice;
    if (mode !== s.mode) changed.mode = mode;
    if (Number(cap) !== s.hourlyCap) changed.hourlyCap = Number(cap);
    if (later !== s.forwardLaterReplies) changed.forwardLaterReplies = later;
    if (countsIntro !== s.countsAsIntroduction) changed.countsAsIntroduction = countsIntro;
    if (!Object.keys(changed).length) return show({ text: "Nothing changed" });
    setBusy(true);
    const r = await send("/api/tools/master-inbox/relay", "PUT", { ...changed, ifUpdatedAt: s.updatedAt });
    setBusy(false);
    show(r.ok ? { text: "Saved" } : { text: r.error ?? "Could not save", bad: true });
    router.refresh();
  };

  return (
    <>
      <Section title="Where it stands" sub={state}>
        <div className="mis-g mis-g2">
          <div>
            <div className="mis-l">This server</div>
            <div className="mut">
              Live sending: <b>{data.server.liveSendAllowed ? "allowed" : "locked"}</b> (OS_BROKERAGE_RELAY_LIVE_SEND) · Postmark token:{" "}
              <b>{data.server.tokenSet ? "set" : "not set"}</b>
            </div>
          </div>
          <div>
            <div className="mis-l">Sends from</div>
            <div className="mut">“Agent name via BrokerStaffer” &lt;{data.server.fromAddress}&gt;, Reply-To the agent</div>
          </div>
        </div>
      </Section>

      <Section title="Switches" sub={s.updatedBy ? `Last changed by ${s.updatedBy}${s.updatedAt ? ` · ${stamp(s.updatedAt, "1970-01-01")}` : ""}` : undefined}>
        <ToggleRow title="Hand-off on" hint="Off stops everything at once — nothing is checked, recorded or sent. Turning it on starts from now: nothing labelled earlier is ever handed off.">
          <Switch checked={enabled} aria-label="Hand-off on" onCheckedChange={setEnabled} />
        </ToggleRow>
        <ToggleRow title="Practice mode" hint="Check and record what would go, to whom — send nothing. Leave on until the practice week has been reviewed.">
          <Switch checked={practice} aria-label="Practice mode" onCheckedChange={setPractice} />
        </ToggleRow>
        <ToggleRow title="Relay the agent's later replies" hint="If the agent writes to us again instead of to the brokerage, pass that on too (once each, to the same people).">
          <Switch checked={later} aria-label="Relay later replies" onCheckedChange={setLater} />
        </ToggleRow>
        <ToggleRow title="Counts as an introduction" hint="Recorded on each hand-off for review only — it does not add the agent to the portal, Follow Up Boss or the numbers.">
          <Switch checked={countsIntro} aria-label="Counts as an introduction" onCheckedChange={setCountsIntro} />
        </ToggleRow>
        <div className="mis-g mis-g2" style={{ marginTop: 16 }}>
          <Field label="When a reply is marked Interested" hint="One click: the conversation shows “Send to brokerage” and nothing goes until someone presses it.">
            <select className="sel" value={mode} onChange={(e) => setMode(e.target.value as RelayMode)}>
              <option value="one_click">Prepare it — a person presses Send to brokerage</option>
              <option value="automatic">Send automatically</option>
            </select>
          </Field>
          <Field label="At most, per brokerage per hour">
            <input className="inp" type="number" min={1} max={100} value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
        </div>
        <div className="mis-act">
          {leavingPractice ? (
            <ConfirmButton
              label="Save — leave practice"
              armedLabel="Click again: brokerages switched on below can receive real emails"
              title="Brokerages switched on below will receive real emails once the server's lock is open."
              onConfirm={save}
              disabled={busy}
            />
          ) : (
            <Btn primary onClick={save} disabled={busy}>
              Save
            </Btn>
          )}
        </div>
      </Section>

      <TestSends tokenSet={data.server.tokenSet} tests={data.tests} />
      <Held data={data} />
      <Brokerages rows={data.brokerages} liveGlobally={s.enabled && !s.practiceMode && data.server.liveSendAllowed && data.server.tokenSet} />
      <Recent data={data} />
    </>
  );
}

/*
 * Test sends (20 Oct): to our own address(es) only, never a brokerage or an
 * agent, and without switching anything live (relay/test-send.ts). The
 * address can be set here (23 Oct) within the limits the server checks.
 */
function TestSends({ tokenSet, tests }: { tokenSet: boolean; tests: RelayOverview["tests"] }) {
  const show = useShowToast();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(tests.recipients);
  const [draft, setDraft] = useState(tests.recipients.join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = draft.trim().toLowerCase() !== saved.join(", ");
  const run = async () => {
    setBusy(true);
    const r = await send("/api/tools/master-inbox/relay/test", "POST", {});
    setBusy(false);
    show(r.ok ? { text: `Test sent to ${String(r.to)} — check that inbox${r.notSent ? `. Not sent to ${String(r.notSent)}` : ""}` } : { text: r.error ?? "Could not send the test", bad: true });
  };
  const save = async () => {
    setSaving(true);
    setErr(null);
    const r = await send("/api/tools/master-inbox/relay/test", "PUT", { recipients: draft });
    setSaving(false);
    if (r.ok && Array.isArray(r.recipients)) {
      const list = (r.recipients as string[]).map(String);
      setSaved(list);
      setDraft(list.join(", "));
      show({ text: `Tests now go to ${list.join(", ")}` });
    } else setErr(r.error ?? "Could not save the test address");
  };
  return (
    <Section title="Test with our own address" sub={`Sends only to ${saved.join(", ")} — never to a brokerage or an agent, and without switching anything live.`}>
      <p className="mut">
        A sample hand-off with made-up words, exactly as a brokerage would receive one, marked TEST. To see a real one, use <b>Test copy</b> on a
        prepared hand-off under Recent hand-offs.
      </p>
      <div className="mis-test-to">
        <Field label="Send tests to" htmlFor="mis-test-to">
          <input id="mis-test-to" className="inp" value={draft} disabled={!tests.ready || saving} onChange={(e) => setDraft(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <Btn onClick={save} disabled={!tests.ready || saving || !changed || !draft.trim()}>{saving ? "Saving…" : "Save"}</Btn>
      </div>
      <p className="mut mis-test-hint">
        {tests.ready
          ? `Up to ${MAX_TEST_RECIPIENTS} addresses, separated by commas. Our own only: an @outreachify.io or @brokerstaffer.com address, or someone on Team access — never a brokerage or an agent. Checked again at every send.`
          : "To change it, run migration 0040_relay_test_recipients.sql in the Master Inbox database first. Until then tests go to admin@outreachify.io."}
      </p>
      {err ? <p className="mis-test-err" role="alert">{err}</p> : null}
      <div className="mis-act" style={{ alignItems: "center", gap: 10 }}>
        <Btn primary onClick={run} disabled={busy || !tokenSet || changed}>
          {busy ? "Sending…" : `Send a sample to ${saved.join(", ")}`}
        </Btn>
        {!tokenSet ? <span className="mut">The Postmark token is not set on this server.</span> : changed ? <span className="mut">Save the address first.</span> : null}
      </div>
    </Section>
  );
}

function TestCopy({ relayId, to }: { relayId: string; to: string[] }) {
  const show = useShowToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="mi-relay-btn"
      disabled={busy}
      title={`Send a copy of this hand-off, marked TEST, to ${to.join(", ")} only`}
      onClick={async () => {
        setBusy(true);
        const r = await send("/api/tools/master-inbox/relay/test", "POST", { relayId });
        setBusy(false);
        show(r.ok ? { text: `Test copy sent to ${String(r.to)}${r.notSent ? `. Not sent to ${String(r.notSent)}` : ""}` } : { text: r.error ?? "Could not send the test", bad: true });
      }}
    >
      {busy ? "Sending…" : "Test copy"}
    </button>
  );
}

function Held({ data }: { data: RelayOverview }) {
  const router = useRouter();
  const show = useShowToast();
  const active = useMemo(() => data.brokerages.filter((b) => b.status === "active"), [data.brokerages]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const answer = async (key: string, h: RelayOverview["held"][number], ignore: boolean) => {
    setBusy(key);
    const r = await send("/api/tools/master-inbox/relay/assign", "POST", {
      platform: h.platform,
      campaignId: h.campaignId,
      campaignName: h.campaignName,
      osClientId: ignore ? null : pick[key] ?? null,
      ignore,
    });
    setBusy(null);
    const queued = Number(r.queued ?? 0);
    show(
      r.ok
        ? { text: `${ignore ? "Marked as not a brokerage campaign" : "Assigned"} — ${String(r.rechecked ?? 0)} conversation(s) checked again${queued ? `, ${queued} more within a few minutes` : ""}` }
        : { text: r.error ?? "Could not save", bad: true },
    );
    if (r.ok) router.refresh();
  };

  return (
    <Section title="Held — campaigns to assign" sub="A campaign that does not match one brokerage is never guessed. Say which brokerage it belongs to, and its conversations are checked again.">
      {data.held.length === 0 ? (
        <p className="mut">Nothing held.</p>
      ) : (
        <div className="tbl-scroll">
          <table className="atbl">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Why</th>
                <th>Conversations</th>
                <th>Brokerage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.held.map((h) => {
                const key = `${h.platform}|${h.campaignId}`;
                return (
                  <tr key={key}>
                    <td>
                      <b>{h.campaignName ?? h.campaignId}</b>
                      <div className="mut">
                        {h.platform} · {h.campaignId}
                      </div>
                    </td>
                    <td>
                      {REASON_TEXT[h.reason] ?? h.reason}
                      {h.detail ? <div className="mut">{h.detail}</div> : null}
                    </td>
                    <td className="tnum">
                      {h.conversations}
                      {h.threadIds[0] ? (
                        <div>
                          <a href={`/inbox/all-email/${h.threadIds[0]}`}>open one</a>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <select className="sel" value={pick[key] ?? ""} onChange={(e) => setPick({ ...pick, [key]: e.target.value })} aria-label="Brokerage">
                        <option value="">Choose…</option>
                        {active.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Btn primary disabled={busy !== null || !pick[key]} onClick={() => answer(key, h, false)}>
                        Assign
                      </Btn>{" "}
                      <ConfirmButton
                        label="Not a brokerage campaign"
                        armedLabel="Click again — never hand these off"
                        title="Its conversations are never handed to a brokerage."
                        onConfirm={() => answer(key, h, true)}
                        disabled={busy !== null}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/*
 * Fifty-odd brokerages (22 Oct, the user: "a very long section … I have to
 * scroll right left … to view the save button"): the list scrolls inside a
 * box of its own with the headings kept in view, the columns are fixed so
 * every row — Save included — fits the card's width, and a search finds one.
 */
function Brokerages({ rows, liveGlobally }: { rows: BrokerageRow[]; liveGlobally: boolean }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((b) => b.name.toLowerCase().includes(s)) : rows;
  }, [rows, q]);
  const on = rows.filter((b) => b.relay.enabled).length;
  return (
    <Section
      title="Brokerages"
      sub="Each brokerage's own switch (the pilot), who receives, one click or automatic, and where its agents enter the portal pipeline. A brokerage that is off is still practised — recorded, never sent. For the pilot: switch on one or two, leave the mode on one click; move to automatic after the pilot."
    >
      <div className="mis-brk-bar">
        <label className="mis-find">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input className="inp" type="search" placeholder="Find a brokerage" aria-label="Find a brokerage" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="mut tnum">
          {q.trim() ? `${shown.length} of ${rows.length}` : `${rows.length} brokerages`} · {on} switched on
        </span>
      </div>
      <div className="mis-brk" role="region" aria-label="Brokerages" tabIndex={0}>
        <table className="atbl">
          <colgroup>
            <col style={{ width: "26%" }} />
            <col style={{ width: "60px" }} />
            <col style={{ width: "21%" }} />
            <col style={{ width: "96px" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "80px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Brokerage</th>
              <th>On</th>
              <th>Receives</th>
              <th>Per hour</th>
              <th>Mode</th>
              <th>Pipeline entry</th>
              <th><span className="sr-only">Save</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <BrokerageLine key={`${b.id}:${JSON.stringify(b.relay)}:${b.pipelineEntry}`} row={b} liveGlobally={liveGlobally} />
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="mut">No brokerage matches “{q.trim()}”.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function BrokerageLine({ row, liveGlobally }: { row: BrokerageRow; liveGlobally: boolean }) {
  const router = useRouter();
  const show = useShowToast();
  const [enabled, setEnabled] = useState(row.relay.enabled);
  const [recipients, setRecipients] = useState<RecipientMode>(row.relay.recipients);
  const [address, setAddress] = useState(row.relay.address ?? "");
  const [cap, setCap] = useState(row.relay.hourlyCap == null ? "" : String(row.relay.hourlyCap));
  const [mode, setMode] = useState<RelayMode | "">(row.relay.mode ?? "");
  const [entry, setEntry] = useState<PipelineEntry>(row.pipelineEntry);
  const [busy, setBusy] = useState(false);
  const dirty =
    enabled !== row.relay.enabled ||
    recipients !== row.relay.recipients ||
    address !== (row.relay.address ?? "") ||
    cap !== (row.relay.hourlyCap == null ? "" : String(row.relay.hourlyCap)) ||
    mode !== (row.relay.mode ?? "") ||
    entry !== row.pipelineEntry;

  const save = async () => {
    setBusy(true);
    // Only what was changed here, with the settings it was changed from (ifRelay): refused if someone saved since (21 Oct review).
    const r = await send("/api/tools/master-inbox/relay/brokerage", "PUT", {
      osClientId: row.id,
      ifRelay: row.relay,
      ...(enabled !== row.relay.enabled ? { enabled } : {}),
      ...(recipients !== row.relay.recipients ? { recipients } : {}),
      ...(address !== (row.relay.address ?? "") ? { address: address || null } : {}),
      ...(cap !== (row.relay.hourlyCap == null ? "" : String(row.relay.hourlyCap)) ? { hourlyCap: cap === "" ? null : Number(cap) } : {}),
      ...(mode !== (row.relay.mode ?? "") ? { mode: mode || null } : {}),
      ...(entry !== row.pipelineEntry ? { pipelineEntry: entry } : {}),
    });
    setBusy(false);
    show(r.ok ? { text: `Saved ${row.name}` } : { text: r.error ?? "Could not save", bad: true });
    router.refresh();
  };

  return (
    <tr>
      <td>
        <b className="mis-brk-name" title={row.name}>{row.name}</b>
        <div className="mut mis-brk-meta">
          {row.status ?? "no status"} · {row.contactsWithEmail}/{row.contacts} contacts with an email
        </div>
      </td>
      <td>
        <Switch checked={enabled} aria-label={`${row.name} on`} onCheckedChange={setEnabled} />
      </td>
      <td>
        <select className="sel" value={recipients} onChange={(e) => setRecipients(e.target.value as RecipientMode)} aria-label="Receives" title="Introduction contacts: the client's introduction contacts, chosen by territory. One address: a single inbox you type.">
          <option value="intro_contacts">Introduction contacts</option>
          <option value="address">One address</option>
        </select>
        {recipients === "address" ? (
          <input className="inp" type="email" placeholder="leads@brokerage.com" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address" />
        ) : null}
      </td>
      <td>
        <input className="inp" type="number" min={1} max={100} placeholder="Default" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Per hour" title="Empty: the hourly limit set above." />
      </td>
      <td>
        <select className="sel" value={mode} onChange={(e) => setMode(e.target.value as RelayMode | "")} aria-label="Mode">
          <option value="">As set above</option>
          <option value="one_click">One click</option>
          <option value="automatic">Automatic</option>
        </select>
      </td>
      <td>
        <select
          className="sel"
          value={entry}
          onChange={(e) => setEntry(e.target.value as PipelineEntry)}
          aria-label="Pipeline entry"
          title="Recorded on each hand-off only. Entering the portal at Interested is not built yet: nothing in the portal changes either way."
        >
          <option value="introduction">Introduction</option>
          <option value="interested">Interested (not built yet)</option>
        </select>
      </td>
      <td>
        {/* Switching a brokerage on while sending is live means real emails from its next hand-off: two clicks. */}
        {enabled && !row.relay.enabled && liveGlobally ? (
          <ConfirmButton
            label="Save"
            armedLabel={`Click again: ${row.name} can receive real emails`}
            title={`${row.name}'s next hand-offs are sent for real (one click: when someone presses Send to brokerage).`}
            onConfirm={save}
            disabled={!dirty || busy}
          />
        ) : (
          <Btn primary disabled={!dirty || busy} onClick={save}>
            Save
          </Btn>
        )}
      </td>
    </tr>
  );
}

function Recent({ data }: { data: RelayOverview }) {
  return (
    <Section title="Recent hand-offs" sub="Every Interested reply the hand-off looked at — practised, held, skipped or sent — newest first. The practice week is reviewed here: View email shows each one exactly as the brokerage would receive it.">
      {data.recent.length === 0 ? (
        <p className="mut">None yet.</p>
      ) : (
        <div className="tbl-scroll">
          <table className="atbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Brokerage</th>
                <th>What happened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <td className="tnum" style={{ whiteSpace: "nowrap" }}>
                    {stamp(r.createdAt, "1970-01-01")}
                  </td>
                  <td>
                    <a href={`/inbox/all-email/${r.threadId}`}>{r.agentName ?? "Open"}</a>
                    {r.kind === "follow_up" ? <div className="mut">later reply</div> : null}
                  </td>
                  <td>{r.brokerageName ?? r.campaignName ?? "—"}</td>
                  <td>
                    {relayLine(r, data.now).text}
                    {r.subject && r.recipients.length ? (
                      <div className="mis-em-line" data-testid="relay-line-email">
                        <div><span>To</span> {r.recipients.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(", ")}</div>
                        <div><span>Subject</span> {r.subject}</div>
                      </div>
                    ) : null}
                    {r.pipelineAction === "enter_at_interested" ? <div className="mut">Pipeline: would enter at Interested (not written)</div> : null}
                  </td>
                  <td>
                    {r.subject && r.recipients.length ? (
                      <div className="mis-em-acts">
                        <RelayEmailButton relayId={r.id} />
                        <TestCopy relayId={r.id} to={data.tests.recipients} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
