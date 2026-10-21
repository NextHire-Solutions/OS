"use client";

/*
 * The redesign's pop-ups, drawn from the handoff's own markup (Pipeline-Add,
 * Pipeline-Upload, Pipeline-Board-Edit / -AddField, Your-Agents-Add / -Import,
 * Team-Add / -Import, DNC-Add-Agent / -Company / -Import). Fields can be typed
 * in — nothing is kept; every Add, Save and Import, and the file chooser, is
 * inert (k.ts RO) and the preview's frame says so — except on the Demo Portal
 * (21–22 Oct), where they save, imports included (`onSave`, `onFile`).
 *
 * Two families, as in the handoff: the pipeline's dialogs (.ov/.dlg, over the
 * whole window) and the list pages' (.aov/.adlg — the pages family's names,
 * see scripts/crm-preview-css.mjs — over the page, under .wrap). The design
 * shows the pipeline's first field focused and the pages' fields not, so only
 * the pipeline's take focus on opening.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { formatPhone, panelFields, type Placement } from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, RO } from "./k";
import { fieldValues } from "./demo-save";

/*
 * On the Demo Portal (21 Oct) a dialog gets `onSave`: its Save / Add reads the
 * dialog's named fields and saves them; the dialog closes once saved. Without
 * `onSave` (every other client) the button stays inert, as before.
 */
type Values = Record<string, string>;
type OnSave = (values: Values) => Promise<boolean>;

function useSaving(onSave: OnSave | undefined, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (need?: (v: Values) => boolean) => {
    if (!onSave || busy) return;
    const v = fieldValues(ref.current);
    if (need && !need(v)) return;
    setBusy(true);
    const ok = await onSave(v);
    setBusy(false);
    if (ok) onClose();
  };
  return { ref, busy, run };
}

/* The save button: live with `onSave`, inert (RO) without. */
function SaveButton({ onSave, busy, ready = true, className, onClick, children }: { onSave?: OnSave; busy: boolean; ready?: boolean; className: string; onClick: () => void; children: ReactNode }) {
  if (!onSave) return <button type="button" className={k(ready ? className : `${className} dim`)} {...RO}>{children}</button>;
  return <button type="button" className={k(ready && !busy ? className : `${className} dim`)} disabled={!ready || busy} onClick={onClick}>{busy ? "Saving…" : children}</button>;
}

/*
 * The CSV drop zone. On the Demo Portal (`onFile`) a click opens the file
 * chooser and a file can be dropped on it; the dialog closes once imported.
 * Without `onFile` it stays inert (RO), as before.
 */
function CsvDrop({ className, onFile, onClose, busyText, children }: { className: string; onFile?: (file: File) => Promise<boolean>; onClose: () => void; busyText: ReactNode; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  // While the dialog is open, a file dropped anywhere but the zone does nothing — the browser would otherwise leave the page to open it (22 Oct audit).
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  if (!onFile) return <button className={k(className)} type="button" {...RO}>{children}</button>;
  const take = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    let ok = false;
    try {
      ok = await onFile(file);
    } finally {
      // Never left on "Importing…", whatever happened.
      setBusy(false);
      if (input.current) input.current.value = "";
    }
    if (ok) onClose();
  };
  return (
    <>
      <button
        className={k(className)}
        type="button"
        disabled={busy}
        aria-busy={busy}
        style={over ? { borderColor: "#3e6bd1", background: "#f5f8fe" } : undefined}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); }}
      >
        {busy ? busyText : children}
      </button>
      <input ref={input} type="file" accept=".csv,text/csv" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void take(e.target.files?.[0])} />
    </>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** mm/dd/yyyy, as the design's date field shows it. */
function mdy(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/* A label as the design's edit form writes it: "Estimated gci", "Mls affiliation". */
const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------- the pipeline's ---

function PipelineDialog({ title, width, onClose, children, foot }: { title: string; width?: number; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  useEscape(onClose);
  return (
    <div className={k("ov")} role="dialog" aria-label={title} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={k("dlg")} style={width ? { width } : undefined}>
        <div className={k("dh")}>
          <h2>{title}</h2>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className={k("db")}>{children}</div>
        <div className={k("df")}>{foot}</div>
      </div>
    </div>
  );
}

/* A text field drawn as the design's .in (its placeholder grey, its blue focus ring). */
function Field({ label, name, placeholder, value, autoFocus, type = "text", readOnly }: { label: string; name?: string; placeholder?: string; value?: string; autoFocus?: boolean; type?: string; readOnly?: boolean }) {
  return (
    <label className={k("fl")}>
      {label}
      <input className={k("in")} name={name} type={type} placeholder={placeholder} defaultValue={value} autoFocus={autoFocus} readOnly={readOnly} {...(readOnly ? RO : {})} />
    </label>
  );
}

function DateField({ label, value }: { label: string; value: string }) {
  return (
    <label className={k("fl")}>
      {label}
      <span className={k("in")} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {value}
        <Icon name="calendar" size={15} />
      </span>
    </label>
  );
}

export function PipelineAddDialog({ now, onClose, onSave }: { now: Date; onClose: () => void; onSave?: OnSave }) {
  const { ref, busy, run } = useSaving(onSave, onClose);
  return (
    <PipelineDialog
      title="Add an agent"
      onClose={onClose}
      foot={<>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
        <SaveButton onSave={onSave} busy={busy} className="btn pri" onClick={() => void run((v) => !!v.name)}>Add agent</SaveButton>
      </>}
    >
      <div ref={ref} style={{ display: "contents" }}>
        <Field label="Name" name="name" placeholder="Jane Doe" autoFocus />
        <div className={k("g2")}>
          <Field label="Email" name="email" placeholder="jane@example.com" type="email" />
          <Field label="Phone" name="phone" placeholder="(123) 456-7890" type="tel" />
          <Field label="Company" name="company" placeholder="Compass" />
          <Field label="Agent profile" name="profile" placeholder="https://..." />
        </div>
        <DateField label="Introduction date" value={mdy(now)} />
      </div>
    </PipelineDialog>
  );
}

export function PipelineUploadDialog({ onClose, onFile }: { onClose: () => void; onFile?: (file: File) => Promise<boolean> }) {
  return (
    <PipelineDialog title="Import agents from CSV" width={640} onClose={onClose} foot={<button type="button" className={k("btn")} onClick={onClose}>Cancel</button>}>
      <CsvDrop className="drop" onFile={onFile} onClose={onClose} busyText={<><Icon name="file" size={26} /><b>Importing…</b></>}>
        <Icon name="file" size={26} />
        <b>Click to choose a CSV file</b>
        <span>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code>,{" "}<code>brokerage</code></span>
        <span>Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Phone Number</code>&nbsp;all&nbsp;work.</span>
      </CsvDrop>
    </PipelineDialog>
  );
}

/** Edit lead, filled from the agent's record; "Add field" adds a blank custom field row, as the design does. */
export function EditLeadDialog({ entry: e, placement, onClose, onSave }: { entry: PipelineEntry; placement: Placement; onClose: () => void; onSave?: OnSave }) {
  const [extra, setExtra] = useState<number[]>([]);
  const { ref, busy, run } = useSaving(onSave, onClose);
  // On the Demo Portal the agent's own fields save; tags (Add tag on the agent) and custom fields are not built yet, so they are drawn only.
  const drawnOnly = !!onSave;
  const fields = panelFields(e);
  const date = e.introduced_at ? mdy(new Date(e.introduced_at)) : "";
  return (
    <PipelineDialog
      title="Edit lead"
      onClose={onClose}
      foot={<>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
        <SaveButton onSave={onSave} busy={busy} className="btn pri" onClick={() => void run((v) => !!v.name)}>Save</SaveButton>
      </>}
    >
      <div ref={ref} style={{ display: "contents" }}>
        <Field label="Name" name="name" value={e.lead_name ?? ""} autoFocus={extra.length === 0} />
        <div className={k("g2")}>
          <Field label="Email" name="email" value={e.lead_email ?? ""} placeholder="jane@example.com" type="email" />
          <Field label="Phone" name="phone" value={e.lead_phone ?? ""} placeholder="(123) 456-7890" type="tel" />
          <Field label="Company" name="company" value={e.current_brokerage ?? ""} placeholder="Compass" />
          <Field label="Agent profile" name="profile" value={e.agent_profile_url ?? ""} placeholder="https://..." />
        </div>
      </div>
      <div className={k("g2")}>
        <DateField label="Introduction date" value={date} />
        <Field label="Tags" value={placement.tag?.label ?? ""} placeholder="Add a tag" readOnly={drawnOnly} />
      </div>
      <div className={k("hr2")} />
      <p className={k("cf")}>Custom fields</p>
      {fields.length ? (
        <div className={k("g2")}>
          {fields.map((f) => <Field key={f.label} label={sentence(f.label)} value={f.value} readOnly={drawnOnly} />)}
        </div>
      ) : null}
      {extra.map((id, i) => (
        <div key={id} className={k("nf")}>
          <Field label="Field name" placeholder="e.g. Coaching Status" autoFocus={i === extra.length - 1} />
          <Field label="Value" placeholder="e.g. Active" />
          <button type="button" className={k("ib")} aria-label="Remove field" onClick={() => setExtra((x) => x.filter((y) => y !== id))}>
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
      <div>
        {drawnOnly ? (
          <button type="button" className={k("btn sm")} {...RO}><Icon name="plus" size={14} />Add field</button>
        ) : (
          <button type="button" className={k("btn sm")} onClick={() => setExtra((x) => [...x, Date.now()])}>
            <Icon name="plus" size={14} />Add field
          </button>
        )}
      </div>
    </PipelineDialog>
  );
}

// ------------------------------------------------------ the list pages' ---

function PageDialog({ title, width, top, onClose, children, foot }: { title: string; width: number; top: number; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  useEscape(onClose);
  return (
    <div className={k("aov")} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={k("adlg")} role="dialog" aria-label={title} style={{ width, marginTop: top }}>
        <div className={k("dh")}>
          <h2>{title}</h2>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className={k("db")}>{children}</div>
        <div className={k("df")}>{foot}</div>
      </div>
    </div>
  );
}

/* The pages' Add buttons are drawn dim until the form has what it needs, as the design shows them empty. */
function AddFoot({ onClose, ready, label = "Add", onSave, busy = false, onAdd }: { onClose: () => void; ready: boolean; label?: string; onSave?: OnSave; busy?: boolean; onAdd?: () => void }) {
  return (
    <>
      <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
      <SaveButton onSave={onSave} busy={busy} ready={ready} className="btn pri" onClick={() => onAdd?.()}>{label}</SaveButton>
    </>
  );
}

/** My Agents' Add (and Edit, with `initial`). */
export function MyAgentAddDialog({ onClose, onSave, initial }: { onClose: () => void; onSave?: OnSave; initial?: { name: string; email: string | null; phone: string | null } }) {
  const [name, setName] = useState(initial?.name ?? "");
  const { ref, busy, run } = useSaving(onSave, onClose);
  return (
    <PageDialog title={initial ? "Edit agent" : "Add an agent"} width={460} top={250} onClose={onClose} foot={<AddFoot onClose={onClose} ready={!!name.trim()} label={initial ? "Save" : "Add"} onSave={onSave} busy={busy} onAdd={() => void run()} />}>
      <div ref={ref} style={{ display: "contents" }}>
        <label className={k("fl")}>
          Full name
          <input className={k("in")} name="name" type="text" placeholder="" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className={k("ag2")}>
          <label className={k("fl")}>Email<input className={k("in")} name="email" type="email" placeholder="" defaultValue={initial?.email ?? ""} /></label>
          <label className={k("fl")}>Phone<input className={k("in")} name="phone" type="tel" placeholder="" defaultValue={initial?.phone ?? ""} /></label>
        </div>
      </div>
      <p className={k("hint")}>My Agents you add are excluded from&nbsp;outreach.</p>
    </PageDialog>
  );
}

/** DNC's Add (and Edit, with `initial` — the kind then stays). */
export function DncAddDialog({ initial = "agent", onClose, onSave, entry }: { initial?: "agent" | "company"; onClose: () => void; onSave?: OnSave; entry?: { name: string; email: string | null; phone: string | null; brokerage: string | null; domain: string | null; notes: string | null } }) {
  const [kind, setKind] = useState<"agent" | "company">(initial);
  const [name, setName] = useState(entry?.name ?? "");
  const { ref, busy, run } = useSaving(onSave ? (v) => onSave({ ...v, kind }) : undefined, onClose);
  return (
    <PageDialog title={entry ? "Edit DNC entry" : "Add to DNC list"} width={460} top={kind === "agent" ? 150 : 170} onClose={onClose} foot={<AddFoot onClose={onClose} ready={!!name.trim()} label={entry ? "Save" : "Add"} onSave={onSave} busy={busy} onAdd={() => void run()} />}>
      <div ref={ref} style={{ display: "contents" }}>
      {entry ? null : (
        <nav className={k("seg2")} aria-label="Entry type">
          <a href="#" className={kind === "agent" ? k("on") : undefined} aria-current={kind === "agent" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setKind("agent"); }}>Agent</a>
          <a href="#" className={kind === "company" ? k("on") : undefined} aria-current={kind === "company" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setKind("company"); }}>Company</a>
        </nav>
      )}
      {kind === "agent" ? (
        <>
          <label className={k("fl")}>Agent name<input key="an" className={k("in")} name="name" type="text" placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className={k("ag2")}>
            <label className={k("fl")}>Email<input className={k("in")} name="email" type="email" placeholder="optional" defaultValue={entry?.email ?? ""} /></label>
            <label className={k("fl")}>Phone<input className={k("in")} name="phone" type="tel" placeholder="optional" defaultValue={entry?.phone ?? ""} /></label>
          </div>
          <label className={k("fl")}>Brokerage<input className={k("in")} name="brokerage" type="text" placeholder="optional" defaultValue={entry?.brokerage ?? ""} /></label>
        </>
      ) : (
        <>
          <label className={k("fl")}>Company name<input key="cn" className={k("in")} name="name" type="text" placeholder="Acme Realty" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className={k("fl")}>Domain<input className={k("in")} name="domain" type="text" placeholder="e.g. kellerwilliams.com" defaultValue={entry?.domain ?? ""} /></label>
            <p className={k("hint")}>{onSave ? <>On the Demo Portal this is saved to its list only — it is not sent to the email&nbsp;providers.</> : <>We&apos;ll block every email at this domain across&nbsp;providers.</>}</p>
          </div>
        </>
      )}
      <label className={k("fl")}>Notes<textarea className={k("ta")} name="notes" rows={3} placeholder="optional" defaultValue={entry?.notes ?? ""} /></label>
      </div>
      <p className={k("hint")}>When you add an agent or company, we will exclude them and their agents from&nbsp;outreach.</p>
    </PageDialog>
  );
}

const IMPORT_TITLE = { agents: "Import agents from CSV", team: "Import team members from CSV", dnc: "Import DNC entries from CSV" } as const;

export function ImportDialog({ kind, onClose, onFile }: { kind: keyof typeof IMPORT_TITLE; onClose: () => void; onFile?: (file: File) => Promise<boolean> }) {
  return (
    <PageDialog title={IMPORT_TITLE[kind]} width={720} top={230} onClose={onClose} foot={<button type="button" className={k("btn")} onClick={onClose}>Cancel</button>}>
      <CsvDrop className="adrop" onFile={onFile} onClose={onClose} busyText={<><span style={{ color: "#6b7280" }}><Icon name="file" size={26} /></span><span className={k("dt")}>Importing…</span></>}>
        <span style={{ color: "#6b7280" }}><Icon name="file" size={26} /></span>
        <span className={k("dt")}>Click to choose a CSV file</span>
        {kind === "agents" ? (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Phone Number</code>{" "}all&nbsp;work.</span>
        ) : kind === "team" ? (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>title</code>,{" "}<code>phone</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Job Title</code>,{" "}<code>Phone Number</code>{" "}all&nbsp;work.</span>
        ) : (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code>,{" "}<code>brokerage</code>,{" "}<code>domain</code>,{" "}<code>kind</code>{" "}(agent or company),{" "}<code>notes</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Current Brokerage</code>{" "}all&nbsp;work.<br />{onFile ? <>On the Demo Portal company rows are saved to its list only — not sent to the email providers; if a row only has an email we extract the domain from&nbsp;it.</> : <>For company rows the{" "}<code>domain</code>{" "}is blocked at every provider; if a row only has an email we extract the domain from&nbsp;it.</>}</span>
        )}
      </CsvDrop>
    </PageDialog>
  );
}

/** Team's Add member is a card on the page, not a pop-up (Team-Add); with `initial`, the same card edits a member. */
export function TeamAddForm({ onClose, onSave, initial }: { onClose: () => void; onSave?: OnSave; initial?: { name: string; email: string; title: string | null; phone: string | null } }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const { ref, busy, run } = useSaving(onSave, onClose);
  return (
    <form className={k("card")} style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }} aria-label={initial ? "Edit team member" : "Add team member"} onSubmit={(e) => e.preventDefault()}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{initial ? "Edit team member" : "Add team member"}</h2>
      <div ref={ref} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <label className={k("fl")}><span className={k("lbu")}>Full name</span><input className={k("in")} name="name" type="text" placeholder="e.g. Maria Lopez" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={k("fl")}><span className={k("lbu")}>Title</span><input className={k("in")} name="title" type="text" placeholder="e.g. Recruiting Manager" defaultValue={initial?.title ?? ""} /></label>
        <label className={k("fl")}><span className={k("lbu")}>Email</span><input className={k("in")} name="email" type="email" placeholder="name@brokerage.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className={k("fl")}><span className={k("lbu")}>Phone</span><input className={k("in")} name="phone" type="tel" placeholder="(305) 555-0000" defaultValue={initial?.phone ?? ""} /></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <SaveButton onSave={onSave} busy={busy} ready={!!(name.trim() && email.trim())} className="btn pri" onClick={() => void run()}>{initial ? "Save" : "Add member"}</SaveButton>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
