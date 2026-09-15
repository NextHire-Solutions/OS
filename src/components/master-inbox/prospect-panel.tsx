"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronUp, ChevronDown, Check, Copy } from "lucide-react";
import { SubsequenceSection } from "@/components/master-inbox/subsequence-status";
import { FollowupCampaignPicker } from "@/components/master-inbox/followup-campaign-picker";
import { labelClass } from "@/components/screens/master-inbox/mockup/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/tools/master-inbox/utils";
import type { ThreadDetail } from "@/lib/tools/master-inbox/inbox/thread-detail";

/*
 * ---------------------------------------------------------------------------
 * WHAT CHANGED IN THIS FILE, AND WHAT DID NOT
 *
 * MARKUP only. The panel is rebuilt on `workspace.css`'s own right-hand-pane
 * vocabulary — `.pcol`, `.phd`, `.pp`, `.pp-tabs`, `.pp-tab`, `.pcard`,
 * `.pcard-h`, `.prow` with its `.k` / `.v` columns, `.av`, `.cbx` — instead of
 * Tailwind boxes with a `rounded-lg border` and an underlined tab strip.
 *
 * Every derivation, fetch, toast and piece of state is unchanged: the
 * `custom_fields` indexing and `find()` resolution order, the email and phone
 * de-duplication, the POST/PATCH calls to `agent-email` and `agent-phone`, the
 * width persistence, the pointer-drag resize, the provider split between
 * subsequences and follow-up campaigns.
 *
 * Two things are new, and both are the design's own answer to something the
 * Tailwind version did by hand:
 *
 *   · label chips use `labelClass()` — the SAME mapper the conversation list
 *     uses — so a label is one colour across the product rather than
 *     emerald-100 here and `.lc-green` two panes to the left.
 *
 *   · "preferred" is the design's `.cbx`, the same checkbox the list rows use.
 */

type TabId = "details" | "attachments" | "notes";

// The panel is user-resizable; the width is persisted so it survives
// reloads and thread switches.
const WIDTH_KEY = "inbox-prospect-panel-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 300;
const MAX_WIDTH = 580;

// normalise a custom-field key for case/punctuation-insensitive matching.
const nkey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function ProspectPanel({ detail }: { detail: ThreadDetail }) {
  const { lead, labels } = detail;
  const [tab, setTab] = useState<TabId>("details");

  // ---- resize ----
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(WIDTH_KEY);
      if (!saved) return;
      const n = Number(saved);
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) setWidth(n);
    } catch {
      // private-mode Safari can throw — ignore.
    }
  }, []);

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Handle is on the LEFT edge — dragging left widens the panel.
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, d.startWidth - (e.clientX - d.startX)),
      );
      setWidth(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        // ignore
      }
    }
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
    e.preventDefault();
  }

  const initials = (lead.full_name || lead.email || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    /*
     * `.pcol` is the design's pane — a column that owns its own scrolling.
     * `.mi-prospect` adds the two things the design file cannot know about:
     * the inline width the user dragged it to, and the z-index that keeps this
     * pane above the composer's overlay (mi-conversation.css §1).
     */
    <aside style={{ width: `${width}px` }} className="pcol mi-prospect">
      {/* Resize handle — left edge. Drawn like the rail's own grip. */}
      <div
        onPointerDown={onHandlePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className={cn("mi-prospect-grip", resizing && "drag")}
      />

      <div className="phd">Prospect details</div>

      <div className="pp">
        <div className="pp-id">
          <span className="tile pp-av">{initials}</span>
          <div className="who">
            <b>{lead.full_name ?? lead.email ?? "Unknown"}</b>
            {lead.email ? (
              <div className="mail">
                <span>{lead.email}</span>
                <button
                  type="button"
                  onClick={() => copy(lead.email!)}
                  className="cp"
                  aria-label="Copy email"
                >
                  <Copy />
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {labels.length > 0 ? (
          <div className="pp-chips">
            {labels.map((l) => (
              <span key={l.id} className={labelClass(l.color)}>
                {l.name}
              </span>
            ))}
          </div>
        ) : null}

        <div className="pp-tabs" role="tablist" aria-label="Prospect detail sections">
          {(["details", "attachments", "notes"] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("pp-tab", tab === t && "on")}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "details" ? <DetailsTab detail={detail} onCopy={copy} /> : null}
        {tab === "attachments" ? (
          <div className="pp-empty">No attachments yet.</div>
        ) : null}
        {tab === "notes" ? <div className="pp-empty">No notes yet.</div> : null}
      </div>
    </aside>
  );
}

/* ------------------------------ details ------------------------------ */

function DetailsTab({
  detail,
  onCopy,
}: {
  detail: ThreadDetail;
  onCopy: (v: string) => void;
}) {
  const { lead } = detail;

  // Index custom_fields once, normalised, dropping empties.
  const entries = Object.entries(lead.custom_fields ?? {})
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => ({ key: k, nk: nkey(k), value: String(v).trim() }));

  const consumed = new Set<string>();
  const find = (...cands: string[]): string | null => {
    for (const c of cands) {
      const e = entries.find((x) => x.nk === c);
      if (e) {
        consumed.add(e.nk);
        return e.value;
      }
    }
    return null;
  };

  // ---- Card 1: general agent info ----
  const phone = find("phone", "phonenumber", "mobile", "cell", "mobilephone", "cellphone");
  // Multi-phone + preferred: a staff-maintained list lives on custom_fields.phones,
  // with the chosen one in custom_fields.preferred_phone. Fall back to the single
  // derived phone above when no list has been created yet.
  const storedPhones = Array.isArray(lead.custom_fields?.phones)
    ? (lead.custom_fields.phones as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim())
    : [];
  const preferredPhone =
    typeof lead.custom_fields?.preferred_phone === "string" &&
    (lead.custom_fields.preferred_phone as string).trim() !== ""
      ? (lead.custom_fields.preferred_phone as string).trim()
      : null;
  const phoneList = storedPhones.length ? storedPhones : phone ? [phone] : [];

  // Agent emails: the lead's own email plus any staff-added emails
  // (custom_fields.emails). De-duplicated case-insensitively.
  const storedEmails = Array.isArray(lead.custom_fields?.emails)
    ? (lead.custom_fields.emails as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim())
    : [];
  const emailSeen = new Set<string>();
  const emailList: string[] = [];
  for (const e of [lead.email, ...storedEmails]) {
    const t = (e ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (emailSeen.has(k)) continue;
    emailSeen.add(k);
    emailList.push(t);
  }
  const preferredEmail =
    typeof lead.custom_fields?.preferred_email === "string" &&
    (lead.custom_fields.preferred_email as string).trim() !== ""
      ? (lead.custom_fields.preferred_email as string).trim()
      : null;
  const website = find(
    "website",
    "websiteurl",
    "homepage",
    "companysite",
    "companywebsite",
    "url",
    "companyurl",
  );
  let location = find("location", "city");
  const state = find("state", "region");
  if (location && state && !location.toLowerCase().includes(state.toLowerCase())) {
    location = `${location}, ${state}`;
  } else if (!location && state) {
    location = state;
  }
  const company = lead.company ?? find("company", "companyname", "organization");
  const title = lead.title ?? find("title", "jobtitle", "role", "position");

  // Mark identity keys consumed so they don't repeat in Card 2.
  for (const c of ["firstname", "lastname", "name", "fullname", "email", "companyname", "jobtitle"]) {
    if (entries.some((e) => e.nk === c)) consumed.add(c);
  }

  // ---- Card 2: everything else Instantly holds ----
  const card2: Array<{ label: string; value: string }> = [];
  if (title) card2.push({ label: "Title", value: title });
  if (lead.linkedin_url) card2.push({ label: "LinkedIn", value: lead.linkedin_url });
  for (const e of entries) {
    if (consumed.has(e.nk)) continue;
    card2.push({ label: prettifyKey(e.key), value: e.value });
  }

  const sourceLabel =
    detail.source_provider === "instantly"
      ? "Instantly"
      : detail.source_provider === "emailbison"
        ? "EmailBison"
        : null;

  return (
    <>
      {/* ---------------- Card 1 — Agent ---------------- */}
      <Card
        title="Agent"
        defaultOpen
        /* Provider-specific sequencing action, in the card's own footer. */
        footer={
          detail.source_provider === "instantly" && detail.campaign_name ? (
            <SubsequenceSection threadId={detail.id} />
          ) : detail.source_provider === "emailbison" ? (
            <FollowupCampaignPicker threadId={detail.id} />
          ) : null
        }
      >
        <Field label="Name" value={lead.full_name} onCopy={onCopy} />
        <AgentEmails
          threadId={detail.id}
          emails={emailList}
          preferred={preferredEmail ?? emailList[0] ?? null}
          onCopy={onCopy}
        />
        <AgentPhones
          threadId={detail.id}
          phones={phoneList}
          preferred={preferredPhone ?? phoneList[0] ?? null}
          onCopy={onCopy}
        />
        <Field label="Company" value={company} onCopy={onCopy} />
        <Field label="Location" value={location} onCopy={onCopy} />
        <Field label="Website" value={website} onCopy={onCopy} />
        <Field label="Campaign" value={detail.campaign_name} onCopy={onCopy} />
        <Field label="Client" value={detail.client_name} onCopy={onCopy} />
        <Field label="Source" value={sourceLabel} />
      </Card>

      {/* ---------------- Card 2 — Lead details ---------------- */}
      {card2.length > 0 ? (
        <Card title="Lead details" defaultOpen>
          <dl>
            {card2.map((row) => (
              <FieldPair
                key={`${row.label}-${row.value}`}
                label={row.label}
                value={row.value}
                onCopy={onCopy}
              />
            ))}
          </dl>
        </Card>
      ) : null}
    </>
  );
}

// Agent email(s), with a "+ Add email" action and a "mark as preferred" checkbox
// (shown when there are 2+ emails), mirroring AgentPhones.
//
// Adding appends the email to the agent's provided values in the external agents
// DB (never overwrites Courted; max_matches:1) and stores it on the lead.
// Marking preferred sets the email the client portal shows at introduction
// (leads.custom_fields.preferred_email + existing pipeline snapshots); it does
// NOT re-push to the agents DB. Fail-open: any error is just a toast.
function AgentEmails({
  threadId,
  emails,
  preferred,
  onCopy,
}: {
  threadId: string;
  emails: string[];
  preferred: string | null;
  onCopy?: (v: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const multi = emails.length >= 2;

  async function addEmail() {
    const email = value.trim();
    if (!email || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/agent-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        toast.success(
          (j.matched ?? 0) > 0
            ? "Email added, and saved to the agent record."
            : "Email added.",
        );
        setValue("");
        setOpen(false);
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't add the email.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function markPreferred(email: string) {
    if (busyEmail !== null || sameEmail(email, preferred)) return;
    setBusyEmail(email);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/agent-email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entriesUpdated?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        const n = j.entriesUpdated ?? 0;
        toast.success(
          n > 0
            ? `Preferred email set. Updated ${n} client portal${n === 1 ? "" : "s"}.`
            : "Preferred email set.",
        );
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't set the preferred email.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setBusyEmail(null);
    }
  }

  return (
    <div className="prow">
      <span className="k">Email</span>
      <div className="v">
        {multi ? (
          <div className="pp-multi">
            {emails.map((e) => {
              const isPref = sameEmail(e, preferred);
              return (
                <div key={e} className="one">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isPref}
                    disabled={busyEmail !== null}
                    onClick={() => markPreferred(e)}
                    className="cbx"
                    aria-label={isPref ? "Preferred email" : "Mark as preferred"}
                    title={isPref ? "Preferred email" : "Mark as preferred"}
                  >
                    {isPref ? <Check /> : null}
                  </button>
                  <span className="val">{e}</span>
                  {isPref ? <span className="pref">Preferred</span> : null}
                  {onCopy ? (
                    <button
                      type="button"
                      onClick={() => onCopy(e)}
                      className="cp"
                      aria-label="Copy email"
                    >
                      <Copy />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <div className="pp-hint">
              The preferred email is shown in the client portal at introduction.
            </div>
          </div>
        ) : emails.length === 1 ? (
          <div className="pp-multi">
            <div className="one">
              <span className="val">{emails[0]}</span>
              {onCopy ? (
                <button
                  type="button"
                  onClick={() => onCopy(emails[0])}
                  className="cp"
                  aria-label="Copy email"
                >
                  <Copy />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Add-email affordance, in the value column under the addresses. */}
        {open ? (
          <div className="pp-add">
            <input
              autoFocus
              type="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addEmail();
                if (e.key === "Escape") {
                  setOpen(false);
                  setValue("");
                }
              }}
              placeholder="name@example.com"
              aria-label="New email address"
            />
            <div className="row">
              <button type="button" onClick={addEmail} disabled={saving} className="pp-btn pri">
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setValue("");
                }}
                className="pp-btn"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="pp-link">
            + Add email
          </button>
        )}
      </div>
    </div>
  );
}

// Compare two phone strings by digits, ignoring formatting.
function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = a.replace(/\D/g, "");
  const nb = b.replace(/\D/g, "");
  return na && nb ? na === nb : a.trim() === b.trim();
}

// Compare two emails case-insensitively.
function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Agent phone(s), with a "mark as preferred" control.
//
//  - 0 numbers: just a "+ Add phone" affordance (matches the old read-only card).
//  - 1 number:  the number shown as a normal field row + "+ Add phone".
//  - 2+ numbers: each number gets a checkbox; the checked one is PREFERRED — the
//    number the client portal shows once the lead is marked as Introduction.
//
// Adding POSTs (external agents DB + stored on the lead); marking preferred
// PATCHes (lead's preferred_phone + already-introduced portal entries + external
// agents DB). Both refresh the panel from the server so the list re-renders.
// Fail-open: any error is just a toast; the inbox never blocks.
function AgentPhones({
  threadId,
  phones,
  preferred,
  onCopy,
}: {
  threadId: string;
  phones: string[];
  preferred: string | null;
  onCopy?: (v: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyPhone, setBusyPhone] = useState<string | null>(null);
  const multi = phones.length >= 2;

  async function addPhone() {
    const phone = value.trim();
    if (!phone || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/agent-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        toast.success(
          (j.matched ?? 0) > 0
            ? "Phone added, and saved to the agent record."
            : "Phone added.",
        );
        setValue("");
        setOpen(false);
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't add the phone number.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function markPreferred(phone: string) {
    if (busyPhone !== null || samePhone(phone, preferred)) return;
    setBusyPhone(phone);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/agent-phone`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entriesUpdated?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        const n = j.entriesUpdated ?? 0;
        toast.success(
          n > 0
            ? `Preferred number set. Updated ${n} client portal${n === 1 ? "" : "s"}.`
            : "Preferred number set.",
        );
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't set the preferred number.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setBusyPhone(null);
    }
  }

  return (
    <div className="prow">
      <span className="k">Phone</span>
      <div className="v">
        {multi ? (
          <div className="pp-multi">
            {phones.map((p) => {
              const isPref = samePhone(p, preferred);
              return (
                <div key={p} className="one">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isPref}
                    disabled={busyPhone !== null}
                    onClick={() => markPreferred(p)}
                    className="cbx"
                    aria-label={isPref ? "Preferred number" : "Mark as preferred"}
                    title={isPref ? "Preferred number" : "Mark as preferred"}
                  >
                    {isPref ? <Check /> : null}
                  </button>
                  <span className="val">{p}</span>
                  {isPref ? <span className="pref">Preferred</span> : null}
                  {onCopy ? (
                    <button
                      type="button"
                      onClick={() => onCopy(p)}
                      className="cp"
                      aria-label="Copy phone"
                    >
                      <Copy />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <div className="pp-hint">
              The preferred number is shown in the client portal at introduction.
            </div>
          </div>
        ) : phones.length === 1 ? (
          <div className="pp-multi">
            <div className="one">
              <span className="val">{phones[0]}</span>
              {onCopy ? (
                <button
                  type="button"
                  onClick={() => onCopy(phones[0])}
                  className="cp"
                  aria-label="Copy phone"
                >
                  <Copy />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Add-phone affordance, in the value column under the numbers. */}
        {open ? (
          <div className="pp-add">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPhone();
                if (e.key === "Escape") {
                  setOpen(false);
                  setValue("");
                }
              }}
              placeholder="+1 (305) 555-0000"
              aria-label="New phone number"
            />
            <div className="row">
              <button type="button" onClick={addPhone} disabled={saving} className="pp-btn pri">
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setValue("");
                }}
                className="pp-btn"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="pp-link">
            + Add phone
          </button>
        )}
      </div>
    </div>
  );
}

/*
 * One labelled row in Card 1 — the design's `.prow` exactly as the mockup
 * draws it: an uppercase key column, and a value that wraps rather than
 * truncating so a long campaign name stays readable and a URL linkifies.
 *
 * The tool put a lucide glyph in front of every label. The approved mockup
 * does not, and the glyph was decoration — the label text is identical and
 * more explicit — so it goes.
 */
function Field({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | null | undefined;
  onCopy?: (v: string) => void;
}) {
  if (!value) return null;
  return (
    <div className="prow">
      <span className="k">{label}</span>
      <span className="v">
        <LinkValue value={value} />
      </span>
      {onCopy ? (
        <button
          type="button"
          onClick={() => onCopy(value)}
          className="cp"
          aria-label={`Copy ${label}`}
        >
          <Copy />
        </button>
      ) : null}
    </div>
  );
}

// Compact key/value row for Card 2 — the same `.prow` without the glyph, so a
// long custom-field name wraps in the key column rather than being clipped.
// The copy button only reveals itself on row hover, so the card stays quiet at
// rest.
function FieldPair({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: (v: string) => void;
}) {
  return (
    <div className="prow plain">
      <dt className="k">{label}</dt>
      <dd className="v">
        <LinkValue value={value} />
      </dd>
      {onCopy ? (
        <button
          type="button"
          onClick={() => onCopy(value)}
          className="cp"
          aria-label={`Copy ${label}`}
        >
          <Copy />
        </button>
      ) : null}
    </div>
  );
}

// Renders a URL value as a link, anything else as plain wrapped text.
function LinkValue({ value }: { value: string }) {
  const v = value.trim();
  if (/^https?:\/\/\S+$/i.test(v)) {
    return (
      <a href={v} target="_blank" rel="noopener noreferrer">
        {v}
      </a>
    );
  }
  return <>{value}</>;
}

function prettifyKey(key: string): string {
  return key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Collapsible titled card — the design's `.pcard`, whose `.pcard-h` heading
// doubles as the toggle.
function Card({
  title,
  children,
  footer = null,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pcard">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pcard-h"
        aria-expanded={open}
      >
        {title}
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open ? children : null}
      {open && footer ? <div className="pcard-foot">{footer}</div> : null}
    </div>
  );
}
