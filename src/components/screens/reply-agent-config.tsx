"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/ui/modal-dialog";

/*
 * The Reply Agents config — modes, clients, questions, handover, schedule.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 *
 * Everything the upgrade plan's §7 says a person can change, in the place the
 * plan puts it: "all edited in the Reply Agents screen". Until now an agent had
 * a tone, a model and a channel; it now also has an operating mode that is
 * acted on, a client it belongs to, a script it works through and a handover
 * that introduces the client by CC.
 *
 * It sits under the existing /reply-agent screen rather than in a new
 * destination, so there is one address for "the reply agent" — what it knows
 * (the corpus, the rules, the record) and now what it does.
 *
 * ---------------------------------------------------------------------------
 * WHY LIVE IS DISABLED RATHER THAN ABSENT
 *
 * The Live option is rendered, described, and not selectable, with the reason
 * next to it. A missing control looks like a feature that was forgotten; a
 * disabled one with an explanation is the system telling the truth about
 * itself. The server refuses `run_mode: "live"` independently (see
 * ai/live-gate.ts) — this is the label, not the lock.
 *
 * ---------------------------------------------------------------------------
 * THE PANELS EXPLAIN THEIR OWN EMPTINESS
 *
 * The same rule the rest of this screen follows. Until migrations 0009 and
 * 0010 have run, the config fields fall back to defaults and the stats panel
 * has no view to read — so each says which migration it is waiting on rather
 * than rendering an unexplained blank.
 */

/* .inp carries min-width:200px, which overflows a narrow dialog grid and makes
 * fields overlap. Scoped here, as elsewhere on this screen. */
const FIELD: React.CSSProperties = { width: "100%", minWidth: 0 };

type RunMode = "pause" | "shadow" | "live";

interface ScheduleJson {
  kind: "always" | "off_hours";
  timezone: string;
  businessDays: number[];
  businessStart: string;
  businessEnd: string;
}

interface Question {
  id: string;
  text: string;
}

interface Agent {
  id: string;
  name: string;
  active: boolean;
  provider: string;
  model: string;
  tone: string;
  channel_filter: string;
  has_api_key: boolean;
  run_mode: RunMode;
  client_ids: string[];
  schedule: ScheduleJson;
  qualification: {
    enabled: boolean;
    questions: Question[];
    required: number;
    passRule: "all_answered" | "any_answered";
  };
  handover: { ccEmails: string[]; message: string };
}

interface ClientRow {
  id: string;
  name: string;
}

interface StatsRow {
  agent_id: string;
  stats: {
    replies_drafted: number;
    replies_sent: number;
    lead_replies_received: number;
    qualification_started: number;
    qualification_qualified: number;
    qualification_handed_over: number;
    qualification_stopped: number;
    sends_held: number;
    reply_rate: number | null;
    qualification_rate: number | null;
    handover_rate: number | null;
    tokens_total: number;
  };
}

const AGENTS_URL = "/api/tools/master-inbox/reply-agents";
const CLIENTS_URL = "/api/tools/master-inbox/clients";
const STATS_URL = "/api/tools/master-inbox/reply-agents/stats";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  const json = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!res.ok) throw new Error(json?.detail ?? json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeSchedule(s: ScheduleJson): string {
  if (!s || s.kind === "always") return "24/7";
  return `Outside ${s.businessStart}–${s.businessEnd}, ${s.businessDays.map((d) => DAY_NAMES[d]).join(" ")} (${s.timezone})`;
}

function pct(v: number | null): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

export function ReplyAgentConfigPanel() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [stats, setStats] = useState<StatsRow[] | null>(null);
  const [statsNote, setStatsNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Agent | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await api<{ agents: Agent[]; live_sending_enabled: boolean }>(AGENTS_URL);
      setAgents(out.agents ?? []);
      setLiveEnabled(Boolean(out.live_sending_enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the agents");
    }
  }, []);

  const loadClients = useCallback(async () => {
    try {
      const out = await api<{ clients?: ClientRow[] } | ClientRow[]>(CLIENTS_URL);
      const rows = Array.isArray(out) ? out : (out.clients ?? []);
      setClients(rows.map((c) => ({ id: c.id, name: c.name })));
    } catch {
      // A missing client list costs the picker, not the screen.
      setClients([]);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const out = await api<{ data: StatsRow[] }>(`${STATS_URL}?per_page=200`);
      setStats(out.data ?? []);
      setStatsNote(null);
    } catch (e) {
      setStats(null);
      setStatsNote(e instanceof Error ? e.message : "Stats unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadClients();
    void loadStats();
  }, [load, loadClients, loadStats]);

  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [clients]);

  const statsFor = useCallback(
    (agentId: string) => stats?.find((s) => s.agent_id === agentId)?.stats ?? null,
    [stats],
  );

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setSaid(null);
    try {
      setSaid(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(null);
    }
  }

  async function setMode(agent: Agent, mode: RunMode) {
    await act(`mode:${agent.id}`, async () => {
      await api(`${AGENTS_URL}/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_mode: mode }),
      });
      await load();
      return mode === "pause"
        ? `${agent.name} is paused. It will not touch another thread until you switch it back.`
        : `${agent.name} is in ${mode} mode.`;
    });
  }

  return (
    <div className="tbl-wrap" style={{ marginBottom: 18 }}>
      <div className="tbl-head">
        <div>
          <div className="tbl-title">Agents</div>
          <div className="tbl-sub">
            What each agent does, whose threads it does it on, and what it asks before handing the
            lead over.
          </div>
        </div>
        <button className="btn" disabled={busy !== null} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div style={{ padding: "4px 22px 22px" }}>
        {/*
          * Stated once, at the top, rather than repeated on every card: Live is
          * off for the whole server, and this is the sentence that says why.
          */}
        {!liveEnabled ? (
          <div
            className="anno"
            style={{ margin: "0 0 14px", background: "var(--amber-bg, #FFF8E6)", borderColor: "var(--amber-border, #F0D48A)" }}
          >
            <b>Live sending is off on this server.</b> The whole live path is built — safety gate,
            schedule, off-hours release, the CC handover and the send itself — but nothing can send
            until someone sets <code>MASTER_INBOX_REPLY_AGENT_LIVE_SEND=1</code> deliberately.
            Shadow shows you exactly what an agent would have sent.
          </div>
        ) : null}

        {error ? (
          <div className="anno" style={{ margin: "0 0 12px", background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }}>
            {error}
          </div>
        ) : null}
        {said ? (
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px" }}>{said}</p>
        ) : null}

        {!agents ? (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Loading…</p>
        ) : agents.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0, lineHeight: 1.7 }}>
            No reply agents yet. They are created in Master Inbox → Settings → Reply Agents; this
            screen configures what they do.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {agents.map((a) => {
              const s = statsFor(a.id);
              return (
                <div
                  key={a.id}
                  style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 14 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 14, fontWeight: 650 }}>{a.name}</div>
                    <ModePill mode={a.run_mode} />
                    {!a.active ? <span className="pill mut">inactive</span> : null}
                    {!a.has_api_key ? <span className="pill mut">no API key</span> : null}
                    <span style={{ flex: 1 }} />
                    {/*
                      * Inline pause / activate, plan §7. One click, no dialog:
                      * pause is the kill switch and a kill switch behind a
                      * modal is not one.
                      */}
                    {a.run_mode === "pause" ? (
                      <button
                        className="btn"
                        style={{ padding: "5px 10px", fontSize: 12.5 }}
                        disabled={busy !== null}
                        onClick={() => void setMode(a, "shadow")}
                      >
                        Activate (shadow)
                      </button>
                    ) : (
                      <button
                        className="btn"
                        style={{ padding: "5px 10px", fontSize: 12.5 }}
                        disabled={busy !== null}
                        onClick={() => void setMode(a, "pause")}
                      >
                        Pause
                      </button>
                    )}
                    <button
                      className="btn"
                      style={{ padding: "5px 10px", fontSize: 12.5 }}
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`dup:${a.id}`, async () => {
                          const out = await api<{ note: string }>(`${AGENTS_URL}/${a.id}/duplicate`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({}),
                          });
                          await load();
                          return out.note;
                        })
                      }
                    >
                      Duplicate
                    </button>
                    <button
                      className="btn btn-pri"
                      style={{ padding: "5px 10px", fontSize: 12.5 }}
                      disabled={busy !== null}
                      onClick={() => setEditing(a)}
                    >
                      Configure
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 12.5, color: "var(--muted)" }}>
                    <span>
                      <b style={{ color: "var(--ink)" }}>Clients:</b>{" "}
                      {a.client_ids.length === 0
                        ? "any (house agent)"
                        : a.client_ids.map(clientName).join(", ")}
                    </span>
                    <span>
                      <b style={{ color: "var(--ink)" }}>Schedule:</b> {describeSchedule(a.schedule)}
                    </span>
                    <span>
                      <b style={{ color: "var(--ink)" }}>Questions:</b>{" "}
                      {a.qualification.enabled ? `${a.qualification.questions.length} asked` : "none"}
                    </span>
                    <span>
                      <b style={{ color: "var(--ink)" }}>Handover:</b>{" "}
                      {a.handover.ccEmails.length > 0
                        ? `introduction, CC client contacts + ${a.handover.ccEmails.join(", ")}`
                        : "introduction, CC client contacts"}
                    </span>
                    <span>
                      <b style={{ color: "var(--ink)" }}>Model:</b> {a.provider}/{a.model}
                    </span>
                  </div>

                  {/* ---- the numbers, plan §8 ---- */}
                  {s ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 10,
                        gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                        marginTop: 12,
                      }}
                    >
                      <Metric label="Drafted" value={s.replies_drafted} />
                      <Metric label="Sent" value={s.replies_sent} sub={pct(s.reply_rate)} />
                      <Metric label="Lead replies" value={s.lead_replies_received} />
                      <Metric
                        label="Qualified"
                        value={s.qualification_qualified}
                        sub={`${pct(s.qualification_rate)} of ${s.qualification_started}`}
                      />
                      <Metric
                        label="Handed over"
                        value={s.qualification_handed_over}
                        sub={pct(s.handover_rate)}
                      />
                      <Metric label="Stopped" value={s.qualification_stopped} />
                      <Metric label="Held" value={s.sends_held} sub="gate refused" />
                      <Metric label="Tokens" value={s.tokens_total} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {statsNote ? (
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7 }}>
            <b style={{ color: "var(--ink)" }}>No numbers yet.</b> {statsNote}
          </p>
        ) : null}
      </div>

      <ModalDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        width={760}
        label="Configure agent"
      >
        {editing ? (
          <AgentEditor
            agent={editing}
            clients={clients}
            liveEnabled={liveEnabled}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
              setSaid("Saved.");
            }}
          />
        ) : null}
      </ModalDialog>
    </div>
  );
}

function ModePill({ mode }: { mode: RunMode }) {
  const look: Record<RunMode, { text: string; bg: string; fg: string }> = {
    pause: { text: "Paused", bg: "var(--inset-2)", fg: "var(--muted)" },
    shadow: { text: "Shadow", bg: "var(--blue-bg, #EAF1FB)", fg: "var(--blue, #2B5FA8)" },
    live: { text: "Live", bg: "#E6F4EE", fg: "#0F6B4F" },
  };
  const l = look[mode];
  return (
    <span
      className="pill"
      style={{ background: l.bg, color: l.fg, fontWeight: 700, letterSpacing: ".03em" }}
      title={
        mode === "pause"
          ? "Does nothing on any thread."
          : mode === "shadow"
            ? "Writes a draft into Master Inbox. Never sends."
            : "Sends automatically, within its schedule and the safety gate."
      }
    >
      {l.text}
    </span>
  );
}

function Metric({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card" style={{ padding: "8px 10px" }}>
      <div className="card-l">{label}</div>
      <div className="card-n tnum" style={{ fontSize: 18 }}>
        {value.toLocaleString()}
      </div>
      {sub ? <div className="card-s">{sub}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- the editor */

function AgentEditor({
  agent,
  clients,
  liveEnabled,
  onClose,
  onSaved,
}: {
  agent: Agent;
  clients: ClientRow[];
  liveEnabled: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<RunMode>(agent.run_mode);
  const [clientIds, setClientIds] = useState<string[]>(agent.client_ids);
  const [questions, setQuestions] = useState<Question[]>(agent.qualification.questions);
  const [qualEnabled, setQualEnabled] = useState(agent.qualification.enabled);
  const [required, setRequired] = useState(agent.qualification.required);
  const [passRule, setPassRule] = useState(agent.qualification.passRule);
  const [cc, setCc] = useState(agent.handover.ccEmails.join(", "));
  const [handoverMessage, setHandoverMessage] = useState(agent.handover.message);
  const [schedule, setSchedule] = useState<ScheduleJson>(agent.schedule);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");

  function moveQuestion(i: number, by: number) {
    const next = [...questions];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setQuestions(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>{agent.name}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          Tone, model and temperature stay in Master Inbox → Settings → Reply Agents. Everything
          about what this agent <i>does</i> is here.
        </div>
      </div>

      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 18 }}>
        {/* ---- mode ---- */}
        <Section title="Mode" sub="What this agent is allowed to do.">
          <div style={{ display: "grid", gap: 8 }}>
            <Radio
              checked={mode === "pause"}
              onChange={() => setMode("pause")}
              label="Pause"
              sub="Does nothing on any thread. The kill switch."
            />
            <Radio
              checked={mode === "shadow"}
              onChange={() => setMode("shadow")}
              label="Shadow"
              sub="Qualifies and writes a draft into Master Inbox. Never sends."
            />
            <Radio
              checked={mode === "live"}
              onChange={() => liveEnabled && setMode("live")}
              disabled={!liveEnabled}
              label="Live"
              sub={
                liveEnabled
                  ? "Sends automatically, within the schedule and the safety gate."
                  : "Unavailable: live sending is not enabled on this server, and the transport is deliberately not wired. Validate shadow first."
              }
            />
          </div>
        </Section>

        {/* ---- clients ---- */}
        <Section
          title="Clients"
          sub="Whose threads this agent runs on. Leave empty and it is a house agent, covering any client that has no agent of its own."
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
            {clients.length === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>No client list available.</span>
            ) : (
              clients.map((c) => {
                const on = clientIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="pill"
                    style={{
                      cursor: "pointer",
                      background: on ? "var(--blue-bg, #EAF1FB)" : "var(--inset-2)",
                      color: on ? "var(--blue, #2B5FA8)" : "var(--muted)",
                      border: "1px solid var(--line)",
                    }}
                    onClick={() =>
                      setClientIds(on ? clientIds.filter((x) => x !== c.id) : [...clientIds, c.id])
                    }
                  >
                    {c.name}
                  </button>
                );
              })
            )}
          </div>
        </Section>

        {/* ---- qualification ---- */}
        <Section
          title="Qualification"
          sub="The questions it works through, one per reply, before the lead is handed over."
        >
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10 }}>
            <input type="checkbox" checked={qualEnabled} onChange={(e) => setQualEnabled(e.target.checked)} />
            Ask these questions before handing over
          </label>
          <div style={{ display: "grid", gap: 8 }}>
            {questions.map((q, i) => (
              <div key={q.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--muted)", width: 16 }}>{i + 1}</span>
                <input
                  className="inp"
                  style={FIELD}
                  value={q.text}
                  maxLength={400}
                  onChange={(e) =>
                    setQuestions(questions.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                  }
                />
                <button type="button" className="btn" style={{ padding: "4px 8px" }} onClick={() => moveQuestion(i, -1)} title="Move up">
                  ↑
                </button>
                <button type="button" className="btn" style={{ padding: "4px 8px" }} onClick={() => moveQuestion(i, 1)} title="Move down">
                  ↓
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "4px 8px" }}
                  onClick={() => setQuestions(questions.filter((_, j) => j !== i))}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            {questions.length < 10 ? (
              <button
                type="button"
                className="btn"
                style={{ justifySelf: "start", padding: "5px 10px", fontSize: 12.5 }}
                onClick={() =>
                  setQuestions([...questions, { id: `q${questions.length + 1}-${Date.now()}`, text: "" }])
                }
              >
                Add a question
              </button>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Answers needed{" "}
              <input
                className="inp"
                style={{ width: 70, minWidth: 0, marginLeft: 6 }}
                type="number"
                min={0}
                max={10}
                value={required}
                onChange={(e) => setRequired(Number(e.target.value))}
              />
            </label>
            <label style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Pass rule{" "}
              <select
                className="inp"
                style={{ width: 190, minWidth: 0, marginLeft: 6 }}
                value={passRule}
                onChange={(e) => setPassRule(e.target.value as "all_answered" | "any_answered")}
              >
                <option value="all_answered">Every question answered</option>
                <option value="any_answered">Enough answers, any order</option>
              </select>
            </label>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>0 means all of them.</span>
          </div>
        </Section>

        {/* ---- handover ---- */}
        <Section
          title="Handover"
          sub="When the lead qualifies, the reply is the introduction — the same message the composer's Introduce button inserts. The agent reads the client from each conversation and CCs that client's introduction contacts automatically, so there is nothing to type here unless you want more."
        >
          <label style={{ display: "block", fontSize: 12.5, color: "var(--muted)", marginBottom: 4 }}>
            Extra addresses to CC (optional)
            <span style={{ display: "block", fontSize: 12, marginTop: 2, lineHeight: 1.6 }}>
              CC defaults to the client&apos;s introduction contacts, up to three people from their
              record. Anything here is added on top, never instead.
            </span>
          </label>
          <input
            className="inp"
            style={{ ...FIELD, marginBottom: 10 }}
            placeholder="extra@example.com"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
          <label style={{ display: "block", fontSize: 12.5, color: "var(--muted)", marginBottom: 4 }}>
            Message override (optional)
            <span style={{ display: "block", fontSize: 12, marginTop: 2, lineHeight: 1.6 }}>
              Empty means the introduction macro. Anything here replaces its wording; template
              variables such as {"{{lead.first_name}}"} still resolve.
            </span>
          </label>
          <textarea
            className="inp"
            style={{ ...FIELD, minHeight: 110, resize: "vertical", fontSize: 12.5, lineHeight: 1.6 }}
            placeholder="Leave empty to use the introduction macro."
            value={handoverMessage}
            maxLength={4000}
            onChange={(e) => setHandoverMessage(e.target.value)}
          />
          <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
            A live introduction is always labelled Introduction once it has sent. That label is
            not bookkeeping — it notifies the client over n8n and Slack, opens a pipeline entry in
            their portal and pushes it to Follow Up Boss — and it goes through the same guarded
            labels path as the Introduce button, which never announces a thread that already
            carries it.
          </p>
        </Section>

        {/* ---- schedule ---- */}
        <Section title="Schedule" sub="When a live agent may send. Ignored in pause and shadow.">
          <div style={{ display: "grid", gap: 8 }}>
            <Radio
              checked={schedule.kind === "always"}
              onChange={() => setSchedule({ ...schedule, kind: "always" })}
              label="24/7"
              sub="Replies go out whenever a lead responds."
            />
            <Radio
              checked={schedule.kind === "off_hours"}
              onChange={() => setSchedule({ ...schedule, kind: "off_hours" })}
              label="Outside business hours only"
              sub="Inside the window it drafts and holds; a background job releases the held replies when the window opens."
            />
          </div>
          {schedule.kind === "off_hours" ? (
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DAY_NAMES.map((d, i) => {
                  const on = schedule.businessDays.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      className="pill"
                      style={{
                        cursor: "pointer",
                        background: on ? "var(--blue-bg, #EAF1FB)" : "var(--inset-2)",
                        color: on ? "var(--blue, #2B5FA8)" : "var(--muted)",
                        border: "1px solid var(--line)",
                      }}
                      onClick={() =>
                        setSchedule({
                          ...schedule,
                          businessDays: on
                            ? schedule.businessDays.filter((x) => x !== i)
                            : [...schedule.businessDays, i].sort((a, b) => a - b),
                        })
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  className="inp"
                  style={{ width: 110, minWidth: 0 }}
                  value={schedule.businessStart}
                  placeholder="09:00"
                  onChange={(e) => setSchedule({ ...schedule, businessStart: e.target.value })}
                />
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>to</span>
                <input
                  className="inp"
                  style={{ width: 110, minWidth: 0 }}
                  value={schedule.businessEnd}
                  placeholder="17:00"
                  onChange={(e) => setSchedule({ ...schedule, businessEnd: e.target.value })}
                />
                <input
                  className="inp"
                  style={{ width: 230, minWidth: 0 }}
                  value={schedule.timezone}
                  placeholder="America/New_York"
                  onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
                />
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Business hours in that timezone. Outside them is when a live agent sends.
              </span>
            </div>
          ) : null}
        </Section>

        {failed ? <div style={{ fontSize: 13, color: "var(--red)" }}>{failed}</div> : null}
      </div>

      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flex: "none" }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-pri"
          style={{ flex: 1 }}
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setFailed("");
            try {
              await api(`${AGENTS_URL}/${agent.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  run_mode: mode,
                  client_ids: clientIds,
                  qualification: {
                    enabled: qualEnabled,
                    questions: questions
                      .filter((q) => q.text.trim().length > 0)
                      .map((q) => ({ id: q.id, text: q.text.trim() })),
                    required,
                    pass_rule: passRule,
                  },
                  handover: {
                    cc_emails: cc
                      .split(/[,;\s]+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                    message: handoverMessage,
                  },
                  schedule:
                    schedule.kind === "always"
                      ? { kind: "always" }
                      : {
                          kind: "off_hours",
                          timezone: schedule.timezone,
                          business_days: schedule.businessDays,
                          business_start: schedule.businessStart,
                          business_end: schedule.businessEnd,
                        },
                }),
              });
              await onSaved();
            } catch (e) {
              setFailed(e instanceof Error ? e.message : "Could not save");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8, lineHeight: 1.6 }}>{sub}</div>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onChange,
  label,
  sub,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        fontSize: 13,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <input type="radio" checked={checked} onChange={onChange} disabled={disabled} style={{ marginTop: 3 }} />
      <span>
        {label}
        <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 2, lineHeight: 1.6 }}>
          {sub}
        </span>
      </span>
    </label>
  );
}
