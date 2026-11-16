"use client";

/*
 * The portal's Campaigns page (17 Nov 2026): the client's campaigns, and an editor for their emails.
 *
 * Eddy and Amy (16 Nov): clients change their emails here — wording, subjects, the days between them, adding and
 * removing emails — any time, with no approval, because every email they change has to fit the rules (125 words, plain
 * text, no links or images). A save goes live in the campaign at once.
 *
 * The rules are lib/crm-preview/campaign-copy.ts, the same code the server checks every save with: what this page
 * flags as the client types is exactly what the server would refuse. The server also re-reads the campaign before
 * writing and refuses a save made from an out-of-date page.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { copyProblem, COPY_RULES, normalizeText, previewText, STANDARD_FIELDS, subjectLength, waitProblem, wordCount, type CopyProblem } from "@/lib/crm-preview/campaign-copy";
import type { CampaignState, CampaignSummary, CampaignView } from "@/lib/crm-preview/campaigns";

import { Icon } from "./icons";
import { k, off, RO } from "./k";
import { useDemo } from "./demo-save";

/* ------------------------------------------------------------------------------------------------- the page --- */

const STATE: Record<CampaignState, { label: string; pill: string; hint: string }> = {
  sending: { label: "Sending", pill: "p-hi", hint: "Changes reach agents who haven't received that email yet." },
  paused: { label: "Paused", pill: "p-ph", hint: "Changes apply when the campaign sends again." },
  draft: { label: "Draft", pill: "p-nu", hint: "Not sending yet. Our team launches it once it's ready." },
  finished: { label: "Finished", pill: "p-nu", hint: "Everything has been sent." },
};

/** The open campaign in the address (?campaign=), so a reload or a shared link opens it again. */
function setCampaignInUrl(id: string | null) {
  const url = new URL(window.location.href);
  const kept = [...url.searchParams].filter(([name]) => name !== "campaign");
  const next = new URLSearchParams(kept);
  if (id) next.set("campaign", id);
  window.history.replaceState(null, "", `${url.pathname}?${next.toString()}`);
}

/**
 * `onGuard`: the frame asks before leaving the page while there are unsaved changes (crm-preview.tsx); this registers
 * the question, or null when there's nothing to lose.
 */
export function CampaignsPage({ clientId, initialCampaign = null, onChat, onGuard }: { clientId: string; initialCampaign?: string | null; onChat: () => void; onGuard: (dirty: (() => boolean) | null) => void }) {
  const [open, setOpen] = useState<string | null>(initialCampaign && /^\d{1,12}$/.test(initialCampaign) ? initialCampaign : null);
  const openOne = (id: string | null) => {
    setOpen(id);
    setCampaignInUrl(id);
    window.scrollTo(0, 0);
  };
  return open ? (
    <CampaignEditor key={open} clientId={clientId} campaignId={open} onBack={() => openOne(null)} onGuard={onGuard} />
  ) : (
    <CampaignList clientId={clientId} onOpen={openOne} onChat={onChat} />
  );
}

type Load<T> = { loading: true } | { loading: false; error: string } | { loading: false; data: T };

async function getJson<T>(request: () => Promise<Response>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await request();
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) return { ok: false, error: j.error ?? (r.status === 404 ? "This campaign isn't available." : "Your campaigns couldn't be loaded just now. Please try again.") };
    return { ok: true, data: j };
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

function CampaignRows({ list, onOpen, label }: { list: CampaignSummary[]; onOpen: (id: string) => void; label: string }) {
  return (
    <div className={k("card")} style={{ overflow: "hidden" }}>
      <ul className="cpv-cmp-list" aria-label={label}>
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" className="cpv-cmp-row" onClick={() => onOpen(c.id)}>
              <span className="cpv-cmp-ic"><Icon name="mail" size={16} /></span>
              <span className="cpv-cmp-name">
                <b>{c.name}</b>
                <small>{STATE[c.state].hint}</small>
              </span>
              <span className={k(`pill ${STATE[c.state].pill}`)}>{STATE[c.state].label}</span>
              <span className="cpv-cmp-go">{c.state === "finished" ? "View emails" : "Edit emails"}<Icon name="next" size={14} /></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CampaignList({ clientId, onOpen, onChat }: { clientId: string; onOpen: (id: string) => void; onChat: () => void }) {
  const [state, setState] = useState<Load<CampaignSummary[]>>({ loading: true });
  const [tick, setTick] = useState(0);
  // Finished campaigns (most of a long-standing client's) wait behind a button; the ones still sending lead.
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true });
    getJson<{ campaigns: CampaignSummary[] }>(() => fetch(`/api/crm-preview/campaigns?client=${encodeURIComponent(clientId)}`, { signal: ctrl.signal }))
      .then((r) => setState(r.ok ? { loading: false, data: r.data.campaigns } : { loading: false, error: r.error }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [clientId, tick]);
  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}><h1>Campaigns</h1></div>
      </header>
      <div className={k("content")}>
        <p className={k("lede")}>
          The emails we send for you. Open a campaign to change its emails: what you save goes live straight away, for every agent who hasn&apos;t received that email&nbsp;yet.
        </p>
        {state.loading ? (
          <div className={k("card")} aria-busy="true"><p className="cpv-cmp-state" role="status">Loading your campaigns…</p></div>
        ) : "error" in state ? (
          <div className={k("card")}>
            <div className="cpv-cmp-state" role="alert">
              <span>{state.error}</span>
              <button type="button" className={k("btn sm")} onClick={() => setTick((t) => t + 1)}><Icon name="refresh" size={14} />Try again</button>
            </div>
          </div>
        ) : state.data.length === 0 ? (
          <div className={k("card")}>
            <div className="cpv-cmp-empty">
              <span className="cpv-cmp-empty-i"><Icon name="campaigns" size={22} /></span>
              <b>No campaigns yet</b>
              <p>Your first campaign is drafted after you finish the Setup wizard. Once it&apos;s ready, it appears here and you can edit its emails.</p>
              <button type="button" className={k("btn")} onClick={onChat}><Icon name="chat" size={15} />Ask support</button>
            </div>
          </div>
        ) : (
          (() => {
            const current = state.data.filter((c) => c.state !== "finished");
            const done = state.data.filter((c) => c.state === "finished");
            return (
              <>
                {current.length ? (
                  <CampaignRows list={current} onOpen={onOpen} label="Your campaigns" />
                ) : (
                  <div className={k("card")}><p className="cpv-cmp-state">None of your campaigns is sending right now.</p></div>
                )}
                {done.length ? (
                  <>
                    <button type="button" className="cpv-cmp-more" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                      <Icon name={showDone ? "back" : "next"} size={14} />
                      {showDone ? "Hide finished campaigns" : `Show ${plural(done.length, "finished campaign")}`}
                    </button>
                    {showDone ? <CampaignRows list={done} onOpen={onOpen} label="Finished campaigns" /> : null}
                  </>
                ) : null}
              </>
            );
          })()
        )}
        <RulesNote />
      </div>
    </>
  );
}

function RulesNote() {
  return (
    <div className={`${k("note")} cpv-cmp-note`}>
      <Icon name="info" size={18} />
      <div>
        <b>The rules for your emails</b>
        <span>Up to {COPY_RULES.maxWords} words each and subjects up to {COPY_RULES.maxSubject} characters. Plain text only: no links, web or email addresses, images or attachments. Personalize with the fields shown under each email.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ the editor --- */

interface DraftVersion { id: number | null; subject: string; text: string; reply?: boolean }
interface DraftEmail {
  key: string;
  id: number | null;
  waitText: string;
  threadReply: boolean;
  /** As loaded: a version follows the email's reply setting only when it is changed (as the server does). */
  origThread: boolean;
  versions: DraftVersion[];
  sent: number;
  off: boolean;
  /** The server's word: not the first, not sent, not off, no A/B versions (a new email: always). */
  removable: boolean;
}

let uid = 0;
const newKey = () => `new-${++uid}`;

function draftOf(v: CampaignView): DraftEmail[] {
  return v.emails.map((e) => ({
    key: String(e.id),
    id: e.id,
    waitText: e.waitBefore === null ? "" : String(e.waitBefore),
    threadReply: e.threadReply,
    origThread: e.threadReply,
    versions: e.versions.map((x) => ({ id: x.id, subject: x.subject, text: x.text, reply: x.reply })),
    sent: e.sent,
    off: e.off,
    removable: e.removable,
  }));
}

const parseWait = (s: string): number | null => (/^\s*\d+\s*$/.test(s) ? Number(s) : s.trim() === "" ? null : Number.NaN);

/** The server's view of a draft. */
function saveInputOf(view: CampaignView, draft: DraftEmail[]) {
  return {
    version: view.version,
    emails: draft.map((e, i) => ({
      id: e.id,
      waitBefore: i === 0 ? null : parseWait(e.waitText),
      threadReply: e.threadReply,
      versions: e.versions.map((v) => ({ id: v.id, subject: v.subject, text: v.text })),
    })),
  };
}

const sameDraft = (a: DraftEmail[], b: DraftEmail[]) =>
  a.length === b.length &&
  a.every((e, i) => {
    const o = b[i];
    return e.id === o.id && e.waitText.trim() === o.waitText.trim() && e.threadReply === o.threadReply && e.versions.length === o.versions.length && e.versions.every((v, j) => v.subject.trim() === o.versions[j].subject.trim() && normalizeText(v.text) === normalizeText(o.versions[j].text));
  });

/** Problems as the server would find them — only on what changed (an untouched email is left as the team wrote it). */
function localProblems(view: CampaignView, draft: DraftEmail[]): Map<string, string> {
  const out = new Map<string, string>();
  const fields = new Set(view.fields);
  const byId = new Map(view.emails.map((e, i) => [e.id as number, { e, i }]));
  draft.forEach((d, i) => {
    const was = d.id === null ? null : byId.get(d.id) ?? null;
    if (was?.e.off) return;
    if (i > 0 && !(was && was.i === 0)) {
      const sameBefore = !!was && was.i > 0 && draft[i - 1].id === view.emails[was.i - 1].id;
      const w = parseWait(d.waitText);
      if (!(sameBefore && w === was!.e.waitBefore)) {
        const p = waitProblem(w);
        if (p) out.set(`${i}:w`, p);
      }
    }
    const threadChanged = !!was && was.e.threadReply !== d.threadReply;
    d.versions.forEach((v, j) => {
      const old = was?.e.versions[j];
      if (!old || normalizeText(v.text) !== normalizeText(old.text)) {
        const p = copyProblem(v.text, "text", fields);
        if (p) out.set(`${i}:${j}:t`, p);
      }
      const replies = versionReplies(d, j);
      if (!replies && (!old || v.subject.trim() !== old.subject.trim() || threadChanged)) {
        const p = copyProblem(v.subject, "subject", fields);
        if (p) out.set(`${i}:${j}:s`, p);
      }
    });
  });
  return out;
}

/** Whether version j of this email goes out as a reply: version A by the email's setting; another version by its own, until the client changes the email's. */
function versionReplies(d: DraftEmail, j: number): boolean {
  if (j === 0 || d.threadReply !== d.origThread) return d.threadReply;
  return d.versions[j]?.reply ?? d.threadReply;
}

const keyOfProblem = (p: CopyProblem) => (p.field === "wait" ? `${p.email}:w` : p.field === "email" ? `${p.email}:e` : `${p.email}:${p.version ?? 0}:${p.field === "subject" ? "s" : "t"}`);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function CampaignEditor({ clientId, campaignId, onBack, onGuard }: { clientId: string; campaignId: string; onBack: () => void; onGuard: (dirty: (() => boolean) | null) => void }) {
  const { live, demo, say } = useDemo();
  const [state, setState] = useState<Load<CampaignView>>({ loading: true });
  const [draft, setDraft] = useState<DraftEmail[]>([]);
  const [tick, setTick] = useState(0);
  const [serverProblems, setServerProblems] = useState<Map<string, string>>(new Map());
  const [banner, setBanner] = useState<{ kind: "ok" | "bad" | "stale"; title: string; lines?: string[] } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ loading: true });
    try {
      const r = await getJson<{ campaign: CampaignView }>(() => fetch(`/api/crm-preview/campaigns?client=${encodeURIComponent(clientId)}&campaign=${encodeURIComponent(campaignId)}`, { signal }));
      if (!r.ok) return setState({ loading: false, error: r.error });
      setState({ loading: false, data: r.data.campaign });
      setDraft(draftOf(r.data.campaign));
      setServerProblems(new Map());
      setShowErrors(false);
    } catch {
      /* aborted */
    }
  }, [clientId, campaignId]);
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, tick]);

  const view = "data" in state ? state.data : null;
  const original = useMemo(() => (view ? draftOf(view) : []), [view]);
  const dirty = !!view && !sameDraft(draft, original);
  const canEdit = !!view && view.editable && live;
  const problems = useMemo(() => {
    if (!view) return new Map<string, string>();
    const local = localProblems(view, draft);
    for (const [key, msg] of serverProblems) if (!local.has(key)) local.set(key, msg);
    return local;
  }, [view, draft, serverProblems]);

  // The frame asks before leaving with unsaved changes; the browser too (closing the tab, reloading).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    onGuard(() => dirtyRef.current);
    const before = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", before);
    return () => { onGuard(null); window.removeEventListener("beforeunload", before); };
  }, [onGuard]);

  useEffect(() => { if (view) headingRef.current?.focus(); }, [view?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (i: number, f: (e: DraftEmail) => DraftEmail) => {
    setDraft((d) => d.map((e, j) => (j === i ? f(e) : e)));
    if (banner?.kind === "ok") setBanner(null);
  };
  const clearServer = (key: string) => setServerProblems((m) => (m.has(key) ? new Map([...m].filter(([x]) => x !== key)) : m));

  const add = () => {
    setDraft((d) => [...d, { key: newKey(), id: null, waitText: "3", threadReply: true, origThread: true, versions: [{ id: null, subject: "", text: "" }], sent: 0, off: false, removable: true }]);
    setTimeout(() => {
      const all = document.querySelectorAll<HTMLTextAreaElement>("textarea[data-cmp-body]");
      all[all.length - 1]?.focus();
      all[all.length - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
  };
  const remove = (i: number) => {
    setDraft((d) => d.filter((_, j) => j !== i));
    // Problems are keyed by position: the server's no longer line up.
    setServerProblems(new Map());
  };
  const discard = () => {
    setDraft(original);
    setServerProblems(new Map());
    setShowErrors(false);
    setBanner(null);
  };

  const askSave = () => {
    if (!dirty || saving) return;
    if (problems.size) {
      setShowErrors(true);
      const first = document.querySelector<HTMLElement>("[data-cmp-problem]");
      first?.scrollIntoView({ block: "center", behavior: "smooth" });
      (first?.closest("[data-cmp-field]")?.querySelector("input, textarea") as HTMLElement | null)?.focus({ preventScroll: true });
      return;
    }
    setConfirm(true);
  };

  const save = async () => {
    if (!view) return;
    setSaving(true);
    try {
      const res = await fetch("/api/crm-preview/campaign-save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientId, campaign: campaignId, save: saveInputOf(view, draft) }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; problems?: CopyProblem[]; campaign?: CampaignView; summary?: string[] };
      setConfirm(false);
      if (res.ok && j.campaign) {
        setState({ loading: false, data: j.campaign });
        setDraft(draftOf(j.campaign));
        setServerProblems(new Map());
        setShowErrors(false);
        const lines = j.summary ?? [];
        setBanner({ kind: "ok", title: lines.length ? (demo ? "Saved on the Demo Portal" : "Saved. Your changes are live.") : "Nothing to save: the emails were already like this.", lines });
        say(demo ? "Saved on the Demo Portal." : "Saved. Your changes are live.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (res.status === 422 && j.problems?.length) {
        setServerProblems(new Map(j.problems.map((p) => [keyOfProblem(p), p.message])));
        setShowErrors(true);
        setBanner({ kind: "bad", title: j.error ?? "Some emails need fixing before they can be saved." });
        return;
      }
      if (res.status === 409 && j.code === "stale") {
        setBanner({ kind: "stale", title: j.error ?? "This campaign changed since you opened it." });
        return;
      }
      if (j.campaign) {
        // Part of it was saved: show what the campaign has now.
        setState({ loading: false, data: j.campaign });
        setDraft(draftOf(j.campaign));
        setServerProblems(new Map());
      }
      setBanner({ kind: "bad", title: j.error ?? "Your changes couldn't be saved just now. Please try again." });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setConfirm(false);
      setBanner({ kind: "bad", title: "Couldn't reach the server, so nothing was saved. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  };

  const back = () => (dirty ? setLeaving(true) : onBack());

  const firstSubject = draft[0]?.versions[0]?.subject ?? "";
  const count = problems.size;

  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}>
          <button type="button" className="cpv-cmp-crumb" onClick={back}><Icon name="back" size={15} />Campaigns</button>
        </div>
      </header>
      <div className={`${k("content")} cpv-cmp-editor${canEdit && (dirty || saving) ? " cpv-cmp-dirty" : ""}`} data-cmp-campaign={campaignId}>
        {state.loading ? (
          <div className={k("card")} aria-busy="true"><p className="cpv-cmp-state" role="status">Loading the emails…</p></div>
        ) : "error" in state ? (
          <div className={k("card")}>
            <div className="cpv-cmp-state" role="alert">
              <span>{state.error}</span>
              <span className="cpv-cmp-actions">
                <button type="button" className={k("btn sm")} onClick={() => setTick((t) => t + 1)}><Icon name="refresh" size={14} />Try again</button>
                <button type="button" className={k("btn sm")} onClick={onBack}>All campaigns</button>
              </span>
            </div>
          </div>
        ) : view ? (
          <>
            <div className="cpv-cmp-head">
              <div>
                <h2 ref={headingRef} tabIndex={-1}>{view.name}</h2>
                <p>
                  <span className={k(`pill ${STATE[view.state].pill}`)}>{STATE[view.state].label}</span>
                  <span>{plural(draft.length, "email")}</span>
                  <span className="cpv-cmp-sep" aria-hidden="true">·</span>
                  <span className="cpv-cmp-hint">{STATE[view.state].hint}</span>
                </p>
              </div>
            </div>

            {banner ? (
              <div className={`cpv-cmp-banner cpv-cmp-${banner.kind}`} role={banner.kind === "ok" ? "status" : "alert"}>
                <Icon name={banner.kind === "ok" ? "check" : "info"} size={18} />
                <div>
                  <b>{banner.title}</b>
                  {banner.lines?.length ? <ul>{banner.lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
                  {banner.kind === "stale" ? <span>Your edits haven&apos;t been saved. Reload to get the latest emails, then make your change again.</span> : null}
                </div>
                {banner.kind === "stale" ? (
                  <button type="button" className={k("btn sm")} onClick={() => { setBanner(null); setTick((t) => t + 1); }}><Icon name="refresh" size={14} />Reload</button>
                ) : (
                  <button type="button" className={k("ib")} aria-label="Dismiss" onClick={() => setBanner(null)}><Icon name="x" size={15} /></button>
                )}
              </div>
            ) : null}

            {!view.editable ? (
              <div className={`${k("note")} cpv-cmp-note`}><Icon name="info" size={18} /><div><b>Read only</b><span>{view.note}</span></div></div>
            ) : !live ? (
              <div className={`${k("note")} cpv-cmp-note`}><Icon name="info" size={18} /><div><b>Read only</b><span>You can see this campaign&apos;s emails but not change them here.</span></div></div>
            ) : (
              <RulesNote />
            )}

            <ol className="cpv-cmp-emails">
              {draft.map((e, i) => (
                <EmailCard
                  key={e.key}
                  index={i}
                  email={e}
                  fields={view.fields}
                  firstSubject={firstSubject}
                  firstVersions={draft[0]?.versions.length ?? 1}
                  canEdit={canEdit && !e.off}
                  lockReason={!live ? null : !view.editable ? view.note : e.off ? "This email was turned off by our team, so it can't be changed here." : null}
                  canRemove={canEdit && i > 0 && e.removable}
                  problems={problems}
                  showErrors={showErrors}
                  onChange={(f) => edit(i, f)}
                  onClearServer={clearServer}
                  onRemove={() => remove(i)}
                />
              ))}
            </ol>

            {canEdit ? (
              draft.length < COPY_RULES.maxEmails ? (
                <button type="button" className="cpv-cmp-add" onClick={add}><Icon name="plus" size={16} />Add a follow-up email</button>
              ) : (
                <p className={k("hint")}>A campaign can have up to {COPY_RULES.maxEmails} emails.</p>
              )
            ) : null}

            {canEdit && (dirty || saving) ? (
              <div className="cpv-cmp-barwrap">
              <div className="cpv-cmp-bar" role="region" aria-label="Unsaved changes">
                <span className="cpv-cmp-bar-t">
                  {count && showErrors ? (
                    <span className="cpv-cmp-bar-bad"><Icon name="info" size={15} />{count === 1 ? "1 thing needs fixing before you can save." : `${count} things need fixing before you can save.`}</span>
                  ) : (
                    <><b>Unsaved changes</b><small>{demo ? "Saving changes the Demo Portal only." : "Saving makes them live in this campaign."}</small></>
                  )}
                </span>
                <button type="button" className={k("btn")} onClick={discard} disabled={saving}>Discard</button>
                <button type="button" className={k("btn pri")} onClick={askSave} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
              </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {confirm && view ? (
        <Dialog
          title={view.state === "draft" ? "Save your changes?" : "Save and go live?"}
          onClose={() => !saving && setConfirm(false)}
          foot={
            <>
              <button type="button" className={k("btn")} onClick={() => setConfirm(false)} disabled={saving}>Keep editing</button>
              <button type="button" className={k("btn pri")} onClick={() => void save()} disabled={saving} data-autofocus>{saving ? "Saving…" : view.state === "draft" ? "Save" : "Save and go live"}</button>
            </>
          }
        >
          <p className="cpv-cmp-dtext">
            {view.state === "draft"
              ? <>Your changes are saved to <b>{view.name}</b>. It isn&apos;t sending yet.</>
              : <>Your changes go live in <b>{view.name}</b> straight away. Agents who already received an email won&apos;t get it again; everyone else gets the new version.</>}
            {demo ? <> On the Demo Portal nothing is sent to anyone.</> : null}
          </p>
        </Dialog>
      ) : null}

      {leaving ? (
        <Dialog
          title="Leave without saving?"
          onClose={() => setLeaving(false)}
          foot={
            <>
              <button type="button" className={k("btn")} onClick={() => setLeaving(false)} data-autofocus>Keep editing</button>
              <button type="button" className={k("btn danger")} onClick={() => { setLeaving(false); onBack(); }}>Discard changes</button>
            </>
          }
        >
          <p className="cpv-cmp-dtext">Your changes to this campaign&apos;s emails haven&apos;t been saved and will be lost.</p>
        </Dialog>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------------------------------------- one email --- */

function EmailCard({
  index: i,
  email: e,
  fields,
  firstSubject,
  firstVersions,
  canEdit,
  lockReason,
  canRemove,
  problems,
  showErrors,
  onChange,
  onClearServer,
  onRemove,
}: {
  index: number;
  email: DraftEmail;
  fields: string[];
  firstSubject: string;
  /** Versions of email 1: with several, a reply's subject depends on which one the agent got. */
  firstVersions: number;
  canEdit: boolean;
  /** Why this viewer, who may save here, can't change this email (a finished campaign, a turned-off email). */
  lockReason: string | null;
  canRemove: boolean;
  problems: Map<string, string>;
  showErrors: boolean;
  onChange: (f: (e: DraftEmail) => DraftEmail) => void;
  onClearServer: (key: string) => void;
  onRemove: () => void;
}) {
  const [tab, setTab] = useState(0);
  const [preview, setPreview] = useState(false);
  const [seed, setSeed] = useState(0);
  const v = e.versions[Math.min(tab, e.versions.length - 1)];
  const j = Math.min(tab, e.versions.length - 1);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"subject" | "text">("text");
  const isReply = i > 0 && versionReplies(e, Math.min(tab, e.versions.length - 1));
  const id = `cmp-${e.key}`;
  const waitKey = `${i}:w`;
  const subjKey = `${i}:${j}:s`;
  const textKey = `${i}:${j}:t`;
  // A problem shows once the field has been changed, or once a save was tried.
  const show = (key: string, touched: boolean) => (showErrors || touched) && problems.get(key);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));

  const setVersion = (f: (x: DraftVersion) => DraftVersion) => onChange((d) => ({ ...d, versions: d.versions.map((x, n) => (n === j ? f(x) : x)) }));

  // The body grows with what's in it.
  useEffect(() => {
    const t = bodyRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.max(132, t.scrollHeight + 2)}px`;
  }, [v.text, preview, tab]);

  const insert = (key: string) => {
    const tag = `{${key}}`;
    const target = lastFocus.current === "subject" && !isReply ? subjectRef.current : bodyRef.current;
    const field = target === subjectRef.current ? "subject" : "text";
    const cur = field === "subject" ? v.subject : v.text;
    const start = target?.selectionStart ?? cur.length;
    const end = target?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + tag + cur.slice(end);
    setVersion((x) => ({ ...x, [field]: next }));
    touch(field === "subject" ? subjKey : textKey);
    onClearServer(field === "subject" ? subjKey : textKey);
    requestAnimationFrame(() => {
      target?.focus();
      const at = start + tag.length;
      target?.setSelectionRange(at, at);
    });
  };

  const words = wordCount(v.text);
  const chars = subjectLength(v.subject);
  const hasChoices = /\{[^{}]*\|/.test(v.text) || /\{[^{}]*\|/.test(v.subject);
  const labelOf = (key: string) => STANDARD_FIELDS.find((f) => f.key === key)?.label ?? `{${key}}`;
  const sentLine = e.off ? "Turned off by our team" : e.sent ? `Sent to ${plural(e.sent, "agent")}` : "Not sent yet";
  const waitProblemText = show(waitKey, !!touched[waitKey]);
  const subjProblem = show(subjKey, !!touched[subjKey]);
  const textProblem = show(textKey, !!touched[textKey]);
  const emailProblem = problems.get(`${i}:e`);
  const ro = canEdit ? {} : { readOnly: true as const, ...(lockReason ? off(lockReason) : RO) };

  return (
    <li className={`cpv-cmp-email${e.off ? " cpv-cmp-off" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="cpv-cmp-eh">
        <span className="cpv-cmp-num" aria-hidden="true">{i + 1}</span>
        <div className="cpv-cmp-when">
          <h3 id={`${id}-h`}>Email {i + 1}{e.id === null ? <span className={k("tag")}>New</span> : null}</h3>
          {i === 0 ? (
            <span>Sent first</span>
          ) : (
            <span className="cpv-cmp-wait" data-cmp-field>
              Sent
              <input
                id={`${id}-wait`}
                className={`${k("in")} cpv-cmp-days${waitProblemText ? " cpv-cmp-invalid" : ""}`}
                type="number"
                inputMode="numeric"
                min={COPY_RULES.minWait}
                max={COPY_RULES.maxWait}
                value={e.waitText}
                aria-label={`Days after email ${i}`}
                aria-invalid={waitProblemText ? true : undefined}
                aria-describedby={waitProblemText ? `${id}-wait-err` : undefined}
                onChange={(ev) => { onChange((d) => ({ ...d, waitText: ev.target.value })); touch(waitKey); onClearServer(waitKey); }}
                onBlur={() => touch(waitKey)}
                {...ro}
              />
              {parseWait(e.waitText) === 1 ? "day" : "days"} after email {i}
            </span>
          )}
        </div>
        <span className={`cpv-cmp-sent${e.sent ? " cpv-cmp-sent-on" : ""}`}>{sentLine}</span>
        <button type="button" className={`${k("btn sm")} cpv-cmp-pv`} aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          <Icon name={preview ? "pencil" : "eye"} size={14} />{preview ? "Edit" : "Preview"}
        </button>
        {canRemove ? (
          <button type="button" className={k("ib")} aria-label={`Remove email ${i + 1}`} title="Remove this email" onClick={onRemove}><Icon name="trash" size={16} /></button>
        ) : null}
      </div>
      {waitProblemText ? <p className="cpv-cmp-err" id={`${id}-wait-err`} data-cmp-problem>{waitProblemText}</p> : null}
      {emailProblem && showErrors ? <p className="cpv-cmp-err" data-cmp-problem>{emailProblem}</p> : null}

      {i > 0 ? (
        <label className="cpv-cmp-thread">
          <input
            type="checkbox"
            className={k("ck")}
            checked={e.threadReply}
            disabled={!canEdit}
            onChange={(ev) => { const on = ev.target.checked; onChange((d) => ({ ...d, threadReply: on })); onClearServer(`${i}:0:s`); }}
          />
          <span>Send as a reply in the same thread</span>
        </label>
      ) : null}

      {e.versions.length > 1 ? (
        <div className={`${k("seg")} cpv-cmp-tabs`} role="tablist" aria-label={`Versions of email ${i + 1}`}>
          {e.versions.map((x, n) => {
            const bad = problems.has(`${i}:${n}:t`) || problems.has(`${i}:${n}:s`);
            return (
              <button key={x.id ?? n} type="button" role="tab" aria-selected={n === j} className={n === j ? k("on") : undefined} onClick={() => setTab(n)}>
                Version {String.fromCharCode(65 + n)}{bad && showErrors ? <span className="cpv-cmp-dot" aria-label="needs fixing" /> : null}
              </button>
            );
          })}
          <span className="cpv-cmp-tabhint">Agents get one version or the other.</span>
        </div>
      ) : null}

      {preview ? (
        <div className="cpv-cmp-preview" aria-label={`Preview of email ${i + 1}`}>
          <div className="cpv-cmp-pvh">
            <span>Subject</span>
            <b>{isReply ? (firstVersions > 1 ? "Re: the subject this agent got on email 1" : `Re: ${previewText(firstSubject, seed)}`) : previewText(v.subject, seed) || <i>No subject</i>}</b>
          </div>
          <div className="cpv-cmp-pvb">{previewText(v.text, seed) || <i>This email is empty.</i>}</div>
          <div className="cpv-cmp-pvf">
            <span>Shown with a sample agent (Jordan) and sender (Alex Morgan).</span>
            {hasChoices ? <button type="button" className={k("btn sm")} onClick={() => setSeed((s) => s + 1)}><Icon name="shuffle" size={14} />Another variation</button> : null}
          </div>
        </div>
      ) : (
        <div className="cpv-cmp-fields">
          {isReply ? (
            <div className="cpv-cmp-replysubj">
              <span>Subject</span>
              <b>{firstVersions > 1 ? "Re: the subject each agent got on email 1" : `Re: ${firstSubject || "the first email's subject"}`}</b>
              <small>A reply goes under the subject of the first email the agent received.</small>
            </div>
          ) : (
            <div className="cpv-cmp-field" data-cmp-field>
              <label className={k("fl")} htmlFor={`${id}-s${j}`}>Subject</label>
              <input
                ref={subjectRef}
                id={`${id}-s${j}`}
                className={`${k("in")}${subjProblem ? " cpv-cmp-invalid" : ""}`}
                value={v.subject}
                maxLength={300}
                placeholder="Write a short subject"
                aria-invalid={subjProblem ? true : undefined}
                aria-describedby={`${id}-s${j}-c${subjProblem ? ` ${id}-s${j}-err` : ""}`}
                onFocus={() => (lastFocus.current = "subject")}
                onChange={(ev) => { const val = ev.target.value; setVersion((x) => ({ ...x, subject: val })); touch(subjKey); onClearServer(subjKey); }}
                onBlur={() => touch(subjKey)}
                {...ro}
              />
              <div className="cpv-cmp-meta">
                {subjProblem ? <p className="cpv-cmp-err" id={`${id}-s${j}-err`} data-cmp-problem>{subjProblem}</p> : <span />}
                <span id={`${id}-s${j}-c`} className={`cpv-cmp-count${chars !== null && chars > COPY_RULES.maxSubject ? " cpv-cmp-over" : ""}`}>{chars ?? "–"}/{COPY_RULES.maxSubject}</span>
              </div>
            </div>
          )}
          <div className="cpv-cmp-field" data-cmp-field>
            <label className={k("fl")} htmlFor={`${id}-t${j}`}>Email</label>
            <textarea
              ref={bodyRef}
              id={`${id}-t${j}`}
              data-cmp-body
              className={`${k("ta")} cpv-cmp-body${textProblem ? " cpv-cmp-invalid" : ""}`}
              value={v.text}
              rows={6}
              spellCheck
              placeholder={i === 0 ? "Hi {FIRST_NAME},\n\nWrite your first email here." : "Write your follow-up here."}
              aria-invalid={textProblem ? true : undefined}
              aria-describedby={`${id}-t${j}-c${textProblem ? ` ${id}-t${j}-err` : ""}`}
              onFocus={() => (lastFocus.current = "text")}
              onChange={(ev) => { const val = ev.target.value; setVersion((x) => ({ ...x, text: val })); touch(textKey); onClearServer(textKey); }}
              onBlur={() => touch(textKey)}
              {...ro}
            />
            <div className="cpv-cmp-meta">
              {textProblem ? <p className="cpv-cmp-err" id={`${id}-t${j}-err`} data-cmp-problem>{textProblem}</p> : <span />}
              <span id={`${id}-t${j}-c`} className={`cpv-cmp-count${words !== null && words > COPY_RULES.maxWords ? " cpv-cmp-over" : ""}`} aria-live="polite">{words ?? "–"}/{COPY_RULES.maxWords} words</span>
            </div>
          </div>
          {canEdit ? (
            <div className="cpv-cmp-insert">
              <span>Insert</span>
              {fields.map((f) => (
                <button key={f} type="button" className={k("chip")} onMouseDown={(ev) => ev.preventDefault()} onClick={() => insert(f)} title={`Adds {${f}} where your cursor is`}>
                  <Icon name="plus" size={12} />{labelOf(f)}
                </button>
              ))}
              {/* A choice of words: EmailBison picks one per agent. */}
              <span className="cpv-cmp-tip">
                {hasChoices
                  ? <>Words in {"{…|…}"} are choices: each agent gets one of them. Preview shows the email as an agent reads it.</>
                  : <>Tip: write {"{Hi|Hello}"} to vary a word between agents.</>}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------------------------------------- the dialog --- */

function Dialog({ title, onClose, foot, children }: { title: string; onClose: () => void; foot: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, read when a key is pressed: the effect below runs once, so the focus isn't moved again on
  // every render (independent review: it bounced to the button and back after each keystroke).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close.current();
      if (ev.key === "Tab" && ref.current) {
        // Keep the focus inside the dialog.
        const f = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, textarea")];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (before?.isConnected) before.focus(); };
  }, []);
  return (
    <div className={`${k("ov")} cpv-cmp-ov`} onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div ref={ref} className={`${k("dlg")} cpv-cmp-dlg`} role="dialog" aria-modal="true" aria-labelledby="cmp-dlg-title">
        <div className={k("dh")}>
          <h2 id="cmp-dlg-title">{title}</h2>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className={k("db")}>{children}</div>
        <div className={k("df")}>{foot}</div>
      </div>
    </div>
  );
}

