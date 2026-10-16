"use client";

/*
 * The redesign's pop-ups, drawn from the handoff's own markup (Pipeline-Add,
 * Pipeline-Upload, Pipeline-Board-Edit / -AddField, Your-Agents-Add / -Import,
 * Team-Add / -Import, DNC-Add-Agent / -Company / -Import). Fields can be typed
 * in — nothing is kept; every Add, Save and Import, and the file chooser, is
 * inert (k.ts RO) and the preview's frame says so.
 *
 * Two families, as in the handoff: the pipeline's dialogs (.ov/.dlg, over the
 * whole window) and the list pages' (.aov/.adlg — the pages family's names,
 * see scripts/crm-preview-css.mjs — over the page, under .wrap). The design
 * shows the pipeline's first field focused and the pages' fields not, so only
 * the pipeline's take focus on opening.
 */

import { useEffect, useState, type ReactNode } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { formatPhone, panelFields, type Placement } from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, RO } from "./k";

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
function Field({ label, placeholder, value, autoFocus, type = "text" }: { label: string; placeholder?: string; value?: string; autoFocus?: boolean; type?: string }) {
  return (
    <label className={k("fl")}>
      {label}
      <input className={k("in")} type={type} placeholder={placeholder} defaultValue={value} autoFocus={autoFocus} />
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

export function PipelineAddDialog({ now, onClose }: { now: Date; onClose: () => void }) {
  return (
    <PipelineDialog
      title="Add an agent"
      onClose={onClose}
      foot={<>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
        <button type="button" className={k("btn pri")} {...RO}>Add agent</button>
      </>}
    >
      <Field label="Name" placeholder="Jane Doe" autoFocus />
      <div className={k("g2")}>
        <Field label="Email" placeholder="jane@example.com" type="email" />
        <Field label="Phone" placeholder="(123) 456-7890" type="tel" />
        <Field label="Company" placeholder="Compass" />
        <Field label="Agent profile" placeholder="https://..." />
      </div>
      <DateField label="Introduction date" value={mdy(now)} />
    </PipelineDialog>
  );
}

export function PipelineUploadDialog({ onClose }: { onClose: () => void }) {
  return (
    <PipelineDialog title="Import agents from CSV" width={640} onClose={onClose} foot={<button type="button" className={k("btn")} onClick={onClose}>Cancel</button>}>
      <button className={k("drop")} type="button" {...RO}>
        <Icon name="file" size={26} />
        <b>Click to choose a CSV file</b>
        <span>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code>,{" "}<code>brokerage</code></span>
        <span>Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Phone Number</code>&nbsp;all&nbsp;work.</span>
      </button>
    </PipelineDialog>
  );
}

/** Edit lead, filled from the agent's record; "Add field" adds a blank custom field row, as the design does. */
export function EditLeadDialog({ entry: e, placement, onClose }: { entry: PipelineEntry; placement: Placement; onClose: () => void }) {
  const [extra, setExtra] = useState<number[]>([]);
  const fields = panelFields(e);
  const date = e.introduced_at ? mdy(new Date(e.introduced_at)) : "";
  return (
    <PipelineDialog
      title="Edit lead"
      onClose={onClose}
      foot={<>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
        <button type="button" className={k("btn pri")} {...RO}>Save</button>
      </>}
    >
      <Field label="Name" value={e.lead_name ?? ""} autoFocus={extra.length === 0} />
      <div className={k("g2")}>
        <Field label="Email" value={e.lead_email ?? ""} placeholder="jane@example.com" type="email" />
        <Field label="Phone" value={formatPhone(e.lead_phone) ?? ""} placeholder="(123) 456-7890" type="tel" />
        <Field label="Company" value={e.current_brokerage ?? ""} placeholder="Compass" />
        <Field label="Agent profile" value={e.agent_profile_url ?? ""} placeholder="https://..." />
      </div>
      <div className={k("g2")}>
        <DateField label="Introduction date" value={date} />
        <Field label="Tags" value={placement.tag?.label ?? ""} placeholder="Add a tag" />
      </div>
      <div className={k("hr2")} />
      <p className={k("cf")}>Custom fields</p>
      {fields.length ? (
        <div className={k("g2")}>
          {fields.map((f) => <Field key={f.label} label={sentence(f.label)} value={f.value} />)}
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
        <button type="button" className={k("btn sm")} onClick={() => setExtra((x) => [...x, Date.now()])}>
          <Icon name="plus" size={14} />Add field
        </button>
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
function AddFoot({ onClose, ready, label = "Add" }: { onClose: () => void; ready: boolean; label?: string }) {
  return (
    <>
      <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
      <button type="button" className={k(ready ? "btn pri" : "btn pri dim")} {...RO}>{label}</button>
    </>
  );
}

export function MyAgentAddDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <PageDialog title="Add an agent" width={460} top={250} onClose={onClose} foot={<AddFoot onClose={onClose} ready={!!name.trim()} />}>
      <label className={k("fl")}>
        Full name
        <input className={k("in")} type="text" placeholder="" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className={k("ag2")}>
        <label className={k("fl")}>Email<input className={k("in")} type="email" placeholder="" /></label>
        <label className={k("fl")}>Phone<input className={k("in")} type="tel" placeholder="" /></label>
      </div>
      <p className={k("hint")}>My Agents you add are excluded from&nbsp;outreach.</p>
    </PageDialog>
  );
}

export function DncAddDialog({ initial = "agent", onClose }: { initial?: "agent" | "company"; onClose: () => void }) {
  const [kind, setKind] = useState<"agent" | "company">(initial);
  const [name, setName] = useState("");
  return (
    <PageDialog title="Add to DNC list" width={460} top={kind === "agent" ? 150 : 170} onClose={onClose} foot={<AddFoot onClose={onClose} ready={!!name.trim()} />}>
      <nav className={k("seg2")} aria-label="Entry type">
        <a href="#" className={kind === "agent" ? k("on") : undefined} aria-current={kind === "agent" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setKind("agent"); }}>Agent</a>
        <a href="#" className={kind === "company" ? k("on") : undefined} aria-current={kind === "company" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setKind("company"); }}>Company</a>
      </nav>
      {kind === "agent" ? (
        <>
          <label className={k("fl")}>Agent name<input key="an" className={k("in")} type="text" placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className={k("ag2")}>
            <label className={k("fl")}>Email<input className={k("in")} type="email" placeholder="optional" /></label>
            <label className={k("fl")}>Phone<input className={k("in")} type="tel" placeholder="optional" /></label>
          </div>
          <label className={k("fl")}>Brokerage<input className={k("in")} type="text" placeholder="optional" /></label>
        </>
      ) : (
        <>
          <label className={k("fl")}>Company name<input key="cn" className={k("in")} type="text" placeholder="Acme Realty" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className={k("fl")}>Domain<input className={k("in")} type="text" placeholder="e.g. kellerwilliams.com" /></label>
            <p className={k("hint")}>We&apos;ll block every email at this domain across&nbsp;providers.</p>
          </div>
        </>
      )}
      <label className={k("fl")}>Notes<textarea className={k("ta")} rows={3} placeholder="optional" /></label>
      <p className={k("hint")}>When you add an agent or company, we will exclude them and their agents from&nbsp;outreach.</p>
    </PageDialog>
  );
}

const IMPORT_TITLE = { agents: "Import agents from CSV", team: "Import team members from CSV", dnc: "Import DNC entries from CSV" } as const;

export function ImportDialog({ kind, onClose }: { kind: keyof typeof IMPORT_TITLE; onClose: () => void }) {
  return (
    <PageDialog title={IMPORT_TITLE[kind]} width={720} top={230} onClose={onClose} foot={<button type="button" className={k("btn")} onClick={onClose}>Cancel</button>}>
      <button className={k("adrop")} type="button" {...RO}>
        <span style={{ color: "#6b7280" }}><Icon name="file" size={26} /></span>
        <span className={k("dt")}>Click to choose a CSV file</span>
        {kind === "agents" ? (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Phone Number</code>{" "}all&nbsp;work.</span>
        ) : kind === "team" ? (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>title</code>,{" "}<code>phone</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Job Title</code>,{" "}<code>Phone Number</code>{" "}all&nbsp;work.</span>
        ) : (
          <span className={k("dc")}>Columns we recognise:{" "}<code>name</code>,{" "}<code>email</code>,{" "}<code>phone</code>,{" "}<code>brokerage</code>,{" "}<code>domain</code>,{" "}<code>kind</code>{" "}(agent or company),{" "}<code>notes</code><br />Headers don&apos;t need to match exactly, e.g.{" "}<code>Full Name</code>,{" "}<code>Email Address</code>,{" "}<code>Current Brokerage</code>{" "}all&nbsp;work.<br />For company rows the{" "}<code>domain</code>{" "}is blocked at every provider; if a row only has an email we extract the domain from&nbsp;it.</span>
        )}
      </button>
    </PageDialog>
  );
}

/** Team's Add member is a card on the page, not a pop-up (Team-Add). */
export function TeamAddForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <form className={k("card")} style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }} aria-label="Add team member" onSubmit={(e) => e.preventDefault()}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add team member</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <label className={k("fl")}><span className={k("lbu")}>Full name</span><input className={k("in")} type="text" placeholder="e.g. Maria Lopez" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className={k("fl")}><span className={k("lbu")}>Title</span><input className={k("in")} type="text" placeholder="e.g. Recruiting Manager" /></label>
        <label className={k("fl")}><span className={k("lbu")}>Email</span><input className={k("in")} type="email" placeholder="name@brokerage.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className={k("fl")}><span className={k("lbu")}>Phone</span><input className={k("in")} type="tel" placeholder="(305) 555-0000" /></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className={k(name.trim() && email.trim() ? "btn pri" : "btn pri dim")} {...RO}>Add member</button>
        <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
