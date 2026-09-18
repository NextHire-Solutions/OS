"use client";

import { useCallback, useEffect, useState } from "react";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ReplyAgentConfigPanel } from "@/components/screens/reply-agent-config";

/*
 * The reply agent's knowledge, and whether it is working.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 *
 * The old agent's record is the reason this feature exists: 517 of its last 600
 * drafts were never sent, and 82 of the 83 that were had been rewritten by
 * hand. Not one went out as written. Everything here exists so that number can
 * be seen moving — or seen not moving, which is the more useful case.
 *
 * Four panels, in the order the work actually flows:
 *
 *   1. THE RECORD     as-written vs light-edit vs rewritten, against that
 *                     baseline. The headline, so it is first.
 *   2. THE CORPUS     how many real replies the agent can draw on, when they
 *                     were gathered, and what situations they cover.
 *   3. THE RULES      the style guide and objection playbook, editable. A
 *                     person's edit wins; a later distillation proposes.
 *   4. PROPOSALS      what the distillation wanted to change, waiting on a
 *                     person. The agent never edits its own instructions.
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN SAYS WHY IT IS EMPTY
 *
 * All four tables come from migrations/0006. Until that has been run, every
 * panel is legitimately empty — and an empty panel that does not explain itself
 * is the single most expensive kind of UI, because the next person spends an
 * afternoon working out whether it is broken. So each panel states the reason
 * and the exact next action instead.
 */

/* Dialog inputs: .inp carries min-width:200px, which overflows a narrow
 * dialog grid and makes fields overlap. Scoped here rather than in
 * workspace.css so nothing outside these dialogs changes. */
const DIALOG_FIELD: React.CSSProperties = { width: "100%", minWidth: 0 };

interface CorpusStatus {
  running: boolean;
  /** False until migrations/0006 has been run. Not the same as "0 examples". */
  available: boolean;
  note: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  examples: number;
  embedded: number;
  lastBuiltAt: string | null;
  byLabel: Array<{ label: string; count: number }>;
  report: { written: number; embedded: number; pairsFound: number; rejected: Record<string, number> } | null;
}

interface Proposal {
  id: string;
  target: "style" | "playbook";
  rule: string;
  status: string;
  createdAt: string;
}

interface Knowledge {
  styleGuide: string | null;
  objectionPlaybook: string | null;
  distilledAt: string | null;
  distilledFrom: number | null;
  updatedBy: string | null;
  proposals: Proposal[];
}

interface Record_ {
  total: number;
  byVerdict: { as_written: number; light_edit: number; rewritten: number; discarded: number };
  asWrittenRate: number | null;
  lastAt: string | null;
  available: boolean;
  baseline: { drafts: number; neverSent: number; sent: number; rewritten: number; asWritten: number };
  backfill: { running: boolean; note: string; error: string | null; report: { written: number; paired: number; discarded: number } | null };
}

const CORPUS_URL = "/api/tools/master-inbox/ai/corpus";
const KNOWLEDGE_URL = "/api/tools/master-inbox/ai/knowledge";
const FEEDBACK_URL = "/api/tools/master-inbox/ai/feedback";
const PROPOSALS_URL = "/api/tools/master-inbox/ai/proposals";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  const json = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!res.ok) throw new Error(json?.detail ?? json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ReplyAgentScreen() {
  const [corpus, setCorpus] = useState<CorpusStatus | null>(null);
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const [record, setRecord] = useState<Record_ | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [editing, setEditing] = useState<"style" | "playbook" | null>(null);

  const loadCorpus = useCallback(async () => {
    try { setCorpus(await api<CorpusStatus>(CORPUS_URL)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not read the corpus"); }
  }, []);
  const loadKnowledge = useCallback(async () => {
    try { setKnowledge(await api<Knowledge>(KNOWLEDGE_URL)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not read the rules"); }
  }, []);
  const loadRecord = useCallback(async () => {
    try { setRecord(await api<Record_>(FEEDBACK_URL)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not read the record"); }
  }, []);

  useEffect(() => { void loadCorpus(); void loadKnowledge(); void loadRecord(); }, [loadCorpus, loadKnowledge, loadRecord]);

  /*
   * Both long jobs are polled rather than awaited — a rebuild reads 37,000
   * messages and a backfill judges 12,000 drafts, which is minutes, not a
   * request. Polling stops the moment neither is running, so an idle screen
   * makes no traffic at all.
   */
  useEffect(() => {
    const live = corpus?.running || record?.backfill?.running;
    if (!live) return;
    const t = setInterval(() => {
      if (corpus?.running) void loadCorpus();
      if (record?.backfill?.running) void loadRecord();
    }, 4000);
    return () => clearInterval(t);
  }, [corpus?.running, record?.backfill?.running, loadCorpus, loadRecord]);

  const act = useCallback(
    async (key: string, run: () => Promise<string | null>) => {
      setBusy(key); setError(null); setSaid(null);
      try {
        const message = await run();
        if (message) setSaid(message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "That did not work");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const rate = record?.asWrittenRate;
  const sentCount = record ? record.byVerdict.as_written + record.byVerdict.light_edit + record.byVerdict.rewritten : 0;

  return (
    <div className="wrap" style={{ maxWidth: 1040 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.01em" }}>Reply agent</h1>
          <p style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 4 }}>
            What the agent has learned from our own replies, and whether its drafts are being sent.
          </p>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          className="btn btn-pri"
          disabled={!!busy || corpus?.running}
          onClick={() =>
            act("rebuild", async () => {
              await api(CORPUS_URL, { method: "POST" });
              await loadCorpus();
              return "Rebuild started — this takes a couple of minutes.";
            })
          }
        >
          {corpus?.running ? "Rebuilding…" : "Rebuild corpus"}
        </button>
      </div>

      {error ? (
        <div className="anno" style={{ margin: "0 0 14px", background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }}>
          <b>Careful — </b>{error}
        </div>
      ) : null}
      {said ? <div className="anno new" style={{ margin: "0 0 14px" }}>{said}</div> : null}

      {/*
       * The one banner that matters most. Every panel below reads from tables
       * that migration 0006 creates; without it they are all empty for the same
       * reason, and saying it four times would be noise.
       */}
      {corpus && !corpus.available ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>The agent&rsquo;s tables are not there yet.</b> Run{" "}
          <code style={{ fontFamily: "var(--mono)" }}>migrations/0006_os_reply_intelligence.sql</code>{" "}
          in the Master Inbox Supabase project, then press Rebuild corpus. Until then the agent
          drafts exactly as it does today — nothing here is switched on.
        </div>
      ) : null}

      {/*
       * The agents themselves — modes, clients, questions, handover, schedule
       * and their numbers. Added by the reply-agent upgrade; a separate file so
       * this screen's four knowledge panels stay readable, and so the whole
       * config surface can be lifted into the standalone Master Inbox app,
       * which is where the plan puts it.
       */}
      <ReplyAgentConfigPanel />

      {/* ------------------------------------------------------- 1. the record */}
      <Panel
        title="The record"
        sub="What happened to the drafts the agent wrote. This is the number to watch."
        action={
          <button
            className="btn"
            disabled={!!busy || record?.backfill?.running}
            onClick={() =>
              act("backfill", async () => {
                await api(FEEDBACK_URL, { method: "POST" });
                await loadRecord();
                return "Judging every past draft — a few minutes.";
              })
            }
          >
            {record?.backfill?.running ? "Judging…" : "Judge past drafts"}
          </button>
        }
      >
        {!record ? (
          <Muted>Loading…</Muted>
        ) : !record.available ? (
          <Muted>
            No record yet — os_reply_feedback does not exist. Run migration 0006, then press
            &ldquo;Judge past drafts&rdquo; to score the {record.baseline.drafts}+ drafts already on file.
          </Muted>
        ) : (
          <>
            <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 14 }}>
              <Stat label="Sent as written" value={record.byVerdict.as_written} sub={typeof rate === "number" ? `${Math.round(rate * 100)}% of sends` : "no sends judged yet"} />
              <Stat label="Lightly edited" value={record.byVerdict.light_edit} sub="mostly kept" />
              <Stat label="Rewritten" value={record.byVerdict.rewritten} sub="started again" />
              <Stat label="Never sent" value={record.byVerdict.discarded} sub="drafted, then dropped" />
            </div>
            <Bar
              parts={[
                { label: "as written", n: record.byVerdict.as_written, colour: "var(--green, #1F9D55)" },
                { label: "light edit", n: record.byVerdict.light_edit, colour: "var(--blue)" },
                { label: "rewritten", n: record.byVerdict.rewritten, colour: "#E0A800" },
              ]}
              total={sentCount}
            />
          </>
        )}

        {/*
          * The baseline is stated whether or not there is a score yet — it is
          * the thing the score means something against, and a screen that only
          * shows it once the feature works would hide the comparison exactly
          * when somebody is deciding whether the work was worth doing.
          */}
        {record ? (
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 12, lineHeight: 1.7 }}>
            <b style={{ color: "var(--ink)" }}>The baseline to beat.</b> Of the old agent&rsquo;s last{" "}
            {record.baseline.drafts} drafts, {record.baseline.neverSent} were never sent. Of the{" "}
            {record.baseline.sent} that were, {record.baseline.rewritten} had been rewritten by hand and{" "}
            {record.baseline.asWritten} went out as written.
            {record.backfill.running ? <> · {record.backfill.note}</> : null}
            {record.lastAt ? <> · last judged {when(record.lastAt)}</> : null}
          </p>
        ) : null}
      </Panel>

      {/* ------------------------------------------------------- 2. the corpus */}
      <Panel
        title="The corpus"
        sub="Real inbound messages paired with the reply we actually sent. Introductions are excluded — they have their own button."
      >
        {!corpus ? (
          <Muted>Loading…</Muted>
        ) : (
          <>
            <div className="cards" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 14 }}>
              <Stat label="Examples" value={corpus.examples} sub={!corpus.available ? "the table does not exist yet" : corpus.examples === 0 ? "nothing to draw on yet" : "real replies"} />
              <Stat label="Searchable" value={corpus.embedded} sub={corpus.examples > 0 && corpus.embedded < corpus.examples ? `${corpus.examples - corpus.embedded} still need a vector` : "embedded"} />
              <Stat label="Last built" value={when(corpus.lastBuiltAt)} sub={corpus.running ? corpus.note : corpus.error ? "last run failed" : "up to date"} />
            </div>
            {corpus.error ? (
              <div className="anno" style={{ margin: "0 0 12px", background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }}>
                <b>The last rebuild failed. </b>{corpus.error}
              </div>
            ) : null}
            {corpus.running ? <Muted>{corpus.note}</Muted> : null}
            {corpus.byLabel.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {corpus.byLabel.map((b) => (
                  <span key={b.label} className="pill mut" title={`${b.count} examples`}>
                    {b.label} <b style={{ marginLeft: 5 }}>{b.count}</b>
                  </span>
                ))}
              </div>
            ) : (
              <Muted>
                {corpus.available
                  ? "No examples yet. Press Rebuild corpus."
                  : "Nothing can be stored until migration 0006 has been run."}
              </Muted>
            )}
          </>
        )}
      </Panel>

      {/* -------------------------------------------------------- 3. the rules */}
      <Panel
        title="What the agent is told"
        sub={
          knowledge?.updatedBy && knowledge.updatedBy !== "distillation"
            ? `Edited by ${knowledge.updatedBy}. A new distillation will propose changes rather than overwrite this.`
            : knowledge?.distilledAt
              ? `Distilled from ${knowledge.distilledFrom ?? 0} examples, ${when(knowledge.distilledAt)}.`
              : "Not distilled yet."
        }
        action={
          <button
            className="btn"
            disabled={!!busy || !corpus || corpus.examples === 0}
            title={corpus?.examples === 0 ? "Build the corpus first — there is nothing to distil from." : undefined}
            onClick={() =>
              act("distil", async () => {
                const out = await api<{ detail?: string }>(KNOWLEDGE_URL, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({}),
                });
                await loadKnowledge();
                return out.detail ?? "Distilled.";
              })
            }
          >
            {busy === "distil" ? "Reading the corpus…" : "Distil from the corpus"}
          </button>
        }
      >
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <Document
            title="House style"
            body={knowledge?.styleGuide ?? null}
            empty="How we write: greeting, length, what we never say. Distil it, then edit it."
            onEdit={() => setEditing("style")}
          />
          <Document
            title="Objection playbook"
            body={knowledge?.objectionPlaybook ?? null}
            empty="How we answer each kind of pushback, one section per situation."
            onEdit={() => setEditing("playbook")}
          />
        </div>
      </Panel>

      {/* ---------------------------------------------------- 4. the proposals */}
      {knowledge && knowledge.proposals.length > 0 ? (
        <Panel
          title="Waiting on you"
          sub="A distillation wanted to change something you had edited. It did not — it asked."
        >
          <div style={{ display: "grid", gap: 10 }}>
            {knowledge.proposals.map((p) => (
              <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {p.target === "style" ? "House style" : "Objection playbook"}
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}> · proposed {when(p.createdAt)}</span>
                </div>
                <pre style={{ margin: "0 0 10px", whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.65, maxHeight: 220, overflowY: "auto", color: "var(--ink-2)" }}>
                  {p.rule}
                </pre>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-pri"
                    disabled={!!busy}
                    onClick={() =>
                      act(`accept:${p.id}`, async () => {
                        await api(PROPOSALS_URL, {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ id: p.id, decision: "accepted" }),
                        });
                        await loadKnowledge();
                        return "Applied.";
                      })
                    }
                  >
                    Use this
                  </button>
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() =>
                      act(`reject:${p.id}`, async () => {
                        await api(PROPOSALS_URL, {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ id: p.id, decision: "rejected" }),
                        });
                        await loadKnowledge();
                        return "Kept yours.";
                      })
                    }
                  >
                    Keep mine
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <ModalDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        width={760}
        label={editing === "playbook" ? "Objection playbook" : "House style"}
      >
        {editing ? (
          <Editor
            which={editing}
            initial={(editing === "style" ? knowledge?.styleGuide : knowledge?.objectionPlaybook) ?? ""}
            onClose={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await loadKnowledge(); setSaid("Saved. Every draft from now on is written against it."); }}
          />
        ) : null}
      </ModalDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Panel({ title, sub, action, children }: { title: string; sub: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tbl-wrap" style={{ marginBottom: 18 }}>
      <div className="tbl-head">
        <div>
          <div className="tbl-title">{title}</div>
          <div className="tbl-sub">{sub}</div>
        </div>
        {action}
      </div>
      <div style={{ padding: "4px 22px 22px" }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className="card-n tnum">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 13, color: "var(--muted)", margin: 0, lineHeight: 1.7 }}>{children}</p>;
}

/*
 * One bar, three segments. Deliberately not a chart library: the whole point is
 * the ratio of three numbers, and a 40px bar says it faster than axes would.
 */
function Bar({ parts, total }: { parts: Array<{ label: string; n: number; colour: string }>; total: number }) {
  if (total === 0) return <Muted>No sends judged yet.</Muted>;
  return (
    <div>
      <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--inset-2)" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ width: `${(p.n / total) * 100}%`, background: p.colour }} title={`${p.label}: ${p.n}`} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: p.colour, display: "inline-block" }} />
            {p.label} <b className="tnum" style={{ color: "var(--ink)" }}>{p.n.toLocaleString()}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Document({ title, body, empty, onEdit }: { title: string; body: string | null; empty: string; onEdit: () => void }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" style={{ padding: "5px 10px", fontSize: 12.5 }} onClick={onEdit}>
          {body ? "Edit" : "Write it"}
        </button>
      </div>
      {body ? (
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.65, maxHeight: 260, overflowY: "auto", color: "var(--ink-2)" }}>
          {body}
        </pre>
      ) : (
        <Muted>{empty}</Muted>
      )}
    </div>
  );
}

/*
 * The editor. Saving marks the document as THIS PERSON'S — which is what makes
 * the next distillation propose instead of overwrite. The dialog says so,
 * because that consequence is invisible otherwise.
 */
function Editor({
  which, initial, onClose, onSaved,
}: { which: "style" | "playbook"; initial: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>
          {which === "style" ? "House style" : "Objection playbook"}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          Goes into every draft, word for word. Once you save, a distillation will propose changes
          here rather than replace what you wrote.
        </div>
      </div>
      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}>
        <textarea
          className="inp"
          style={{ ...DIALOG_FIELD, minHeight: 320, fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: 1.65, resize: "vertical" }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={20000}
          autoFocus
          placeholder={
            which === "style"
              ? "- Open with the first name, no greeting line above it\n- Answer the question before pivoting"
              : "## They are happy where they are\n- Acknowledge it, do not argue\n- \"Totally fair — most of our people were too.\""
          }
        />
        {failed ? <div style={{ fontSize: 13, color: "var(--red)", marginTop: 10 }}>{failed}</div> : null}
      </div>
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flex: "none" }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
        <button
          type="button"
          className="btn btn-pri"
          style={{ flex: 1 }}
          disabled={saving || text === initial}
          onClick={async () => {
            setSaving(true); setFailed("");
            try {
              await api(KNOWLEDGE_URL, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(which === "style" ? { styleGuide: text } : { objectionPlaybook: text }),
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
