"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { countVariations } from "@/lib/tools/analytics/spintax.ts";
import { MERGE_TAGS_URL, saveSequence, useAnalyticsData } from "./actions";
import { CopyTagsPanel } from "./copy-tags-panel";
import { EmailPanel } from "./email-panel";
import { Btn, ConfirmButton, DIM } from "./toast";

/*
 * The sequence editor (spec §9.3) — the tool's
 * `components/campaigns/sequence-editor.tsx`.
 *
 * "Changes are saved only when you press Save. If you try to leave with unsaved
 * edits, you'll be warned. Nothing goes live by accident."
 *
 * Everything below is local state until Save. The component never mutates the
 * server copy, and the Save button is the only thing that can.
 *
 * Reordering is BOTH drag and buttons (§9.3 asks for drag). An earlier pass
 * shipped buttons only, arguing a mis-drag was "a one-slip mistake with no
 * undo" — but nothing here is saved until Save, so a mis-drag is undone by
 * dragging back or by leaving. The real objection was keyboard access, which
 * the buttons still provide. Both, rather than either.
 *
 * Formatting wraps the selection in HTML tags rather than using a WYSIWYG
 * editor, and that is deliberate. Bodies are HTML (297 of 299 steps) but they
 * also carry spintax `{a|b}` and merge tags `{FIRST_NAME}` in the SAME single
 * braces. Every contenteditable surface normalises markup on input, which would
 * rewrite or split those. Wrapping a selection leaves every other byte untouched.
 */

/*
 * Fallback only. The real list comes from /merge-tags, built from the lead
 * custom variables this workspace actually has — the constant that used to live
 * here offered {COMPANY_NAME}, {JOB_TITLE}, {CITY} and {STATE}, none of which
 * appear in any of the 299 steps or map to anything on a lead.
 */
const FALLBACK_MERGE_TAGS = ["{FIRST_NAME}", "{LAST_NAME}", "{EMAIL}", "{COMPANY}"];

/** Wraps the selection. Kept to tags EmailBison renders in an email body. */
const FORMATS = [
  { label: "B", title: "Bold", open: "<strong>", close: "</strong>", style: { fontWeight: 700 } },
  { label: "I", title: "Italic", open: "<em>", close: "</em>", style: { fontStyle: "italic" } },
  { label: "U", title: "Underline", open: "<u>", close: "</u>", style: { textDecoration: "underline" } },
  { label: "¶", title: "Paragraph", open: "<p>", close: "</p>", style: {} },
  { label: "↵", title: "Line break", open: "<br>", close: "", style: {} },
] as const;

export interface EditableStep {
  /** Absent = added in this session, not yet on the platform. */
  id?: number;
  email_subject: string;
  email_body: string;
  wait_in_days: number;
  thread_reply: boolean;
  variant: boolean;
  variant_from_step_id?: number | null;
  /** Local key so React can track rows that have no id yet. */
  key: string;
}

export function SequenceEditor({
  campaignId,
  platform,
  sequenceId,
  initial,
  sentStepIds,
  onDone,
  onSaved,
  show,
}: {
  /** Text: an EmailBison bigint or an Instantly uuid. */
  campaignId: string;
  platform: "emailbison" | "instantly";
  /** EmailBison's sequence handle. Instantly has none and the route ignores it. */
  sequenceId: number | null;
  initial: EditableStep[];
  /** Steps EmailBison will refuse to delete. */
  sentStepIds: number[];
  onDone: () => void;
  onSaved: () => void;
  show: (t: { text: string; bad?: boolean }) => void;
}) {
  const [steps, setSteps] = useState<EditableStep[]>(initial);
  const [open, setOpen] = useState<string | null>(initial[0]?.key ?? null);
  const bodyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const sent = new Set(sentStepIds);
  const dirty = JSON.stringify(steps) !== JSON.stringify(initial);

  /*
   * §9.3: "If you try to leave with unsaved edits, you'll be warned. Nothing
   * goes live by accident."
   *
   * `beforeunload` covers reload, tab close and navigation away from the app.
   * It cannot cover an in-app route change, which the workspace shell performs
   * without unloading; the Save/Discard bar stays visible for that case, which
   * is why it is pinned rather than inline.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore custom text now and show their own wording; assigning
      // returnValue is still what triggers the prompt at all.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const mergeTags = useAnalyticsData<{ tags: string[] }>(MERGE_TAGS_URL);
  const tags = mergeTags.data?.tags?.length ? mergeTags.data.tags : FALLBACK_MERGE_TAGS;

  async function save() {
    /*
     * EmailBison addresses a sequence by id and the route refuses without one;
     * Instantly holds one sequence per campaign and has no such id. The tool
     * checks the id unconditionally, which its own route contradicts for
     * Instantly — the platform decides here instead.
     */
    if (platform === "emailbison" && !sequenceId) {
      setSaveError("This campaign has no sequence id cached yet. Run sync-entities, then reload.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveSequence(
        campaignId,
        platform === "emailbison" ? sequenceId : null,
        steps.map((s) => ({
          id: s.id,
          email_subject: s.email_subject,
          email_body: s.email_body,
          wait_in_days: s.wait_in_days,
          thread_reply: s.thread_reply,
          variant: s.variant,
          variant_from_step_id: s.variant_from_step_id ?? null,
        })),
      );
      show({ text: platform === "instantly" ? "Sequence saved to Instantly" : "Sequence saved to EmailBison" });
      onSaved();
      onDone();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "The sequence could not be saved");
    } finally {
      setSaving(false);
    }
  }

  function update(index: number, patch: Partial<EditableStep>) {
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    setSteps(next);
  }

  /**
   * Drag reorder (§9.3), moving the dragged step to the drop position.
   *
   * Not a swap. `move` swaps because it steps one place at a time, but dragging
   * step 1 onto step 4 must leave 2 and 3 shifted up — a swap there would
   * silently reorder two steps the user never touched.
   */
  function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSteps(next);
  }

  function remove(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  function add() {
    const key = `new-${Date.now()}`;
    setSteps([
      ...steps,
      {
        key,
        email_subject: "",
        email_body: "",
        // Defaults that match the workspace's dominant pattern rather than
        // zeros, which would send the whole sequence at once.
        wait_in_days: 1,
        thread_reply: steps.length > 0,
        variant: false,
      },
    ]);
    setOpen(key);
  }

  /**
   * Wraps the current selection, or inserts at the cursor when nothing is
   * selected. Operates on the raw text so spintax and merge tags survive byte
   * for byte — the reason this is not a WYSIWYG editor.
   */
  function wrap(index: number, openTag: string, closeTag: string) {
    const field = bodyRefs.current[steps[index].key];
    const body = steps[index].email_body;
    if (!field) return update(index, { email_body: body + openTag + closeTag });

    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    const next = body.slice(0, start) + openTag + body.slice(start, end) + closeTag + body.slice(end);
    update(index, { email_body: next });

    queueMicrotask(() => {
      field.focus();
      // Leave the wrapped text selected so a second format can be applied, and
      // put the caret inside the tags when nothing was selected.
      field.setSelectionRange(start + openTag.length, end + openTag.length);
    });
  }

  /** Inserts at the cursor rather than appending — §9.3 asks for a menu, not typing. */
  function insertTag(index: number, tag: string) {
    const field = bodyRefs.current[steps[index].key];
    const body = steps[index].email_body;
    if (!field) return update(index, { email_body: body + tag });
    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    update(index, { email_body: body.slice(0, start) + tag + body.slice(end) });
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  const platformName = platform === "instantly" ? "Instantly" : "EmailBison";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* Pinned, so the way out is always in view — see the beforeunload note. */}
      <div
        style={{
          position: "sticky", top: 0, zIndex: 20, display: "flex", flexWrap: "wrap", alignItems: "center",
          gap: 10, padding: "10px 14px", background: "var(--inset)", border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Editing sequence</span>
        <span className="mut" style={{ fontSize: 12 }}>Nothing is sent to {platformName} until you press Save.</span>
        <span style={{ flex: 1 }} />
        {dirty ? <span className="badge s-ok">Unsaved changes</span> : null}
        <Btn disabled={!dirty || saving} onClick={() => setSteps(initial)}>Revert</Btn>
        {dirty ? (
          // §9.3: warned before losing edits. The tool's window.confirm becomes
          // the workspace's armed second click.
          <ConfirmButton
            label="Cancel"
            armedLabel="Discard unsaved changes"
            title="Discard your unsaved changes to this sequence?"
            disabled={saving}
            onConfirm={onDone}
          />
        ) : (
          <Btn disabled={saving} onClick={onDone}>Cancel</Btn>
        )}
        <Btn primary disabled={!dirty || saving || steps.length === 0} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </div>

      {saveError ? (
        <div
          style={{
            border: "1px solid var(--red)", background: "var(--red-bg)", color: "var(--red)",
            borderRadius: "var(--r-md)", padding: "8px 10px", fontSize: 12.5, whiteSpace: "pre-line",
          }}
        >
          {saveError}
        </div>
      ) : null}

      {steps.map((step, index) => {
        const isNew = step.id == null;
        const locked = step.id != null && sent.has(step.id);
        const variations = countVariations(step.email_body);
        const isOpen = open === step.key;

        return (
          <div key={step.key} className="abox" style={{ marginBottom: 0 }}>
            <div
              /*
               * Drop target. `dragOver` must preventDefault or the browser
               * refuses the drop entirely — the single most common reason
               * native HTML5 drag "does nothing".
               */
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                setDropIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) reorder(dragIndex, index);
                setDragIndex(null);
                setDropIndex(null);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                borderBottom: isOpen ? "1px solid var(--line-soft)" : undefined,
                background: dropIndex === index && dragIndex !== index ? "var(--blue-pale)" : undefined,
                opacity: dragIndex === index ? 0.4 : 1,
              }}
            >
              {/*
                Only the handle is draggable, not the row: a draggable row makes
                selecting the subject text start a drag instead.
              */}
              <span
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                title="Drag to reorder"
                aria-hidden
                style={{ cursor: "grab", color: "var(--muted)", flex: "none", fontSize: 16, lineHeight: 1, userSelect: "none" }}
              >
                ⠿
              </span>

              {/*
                Numbered by POSITION IN THE SEQUENCE, not by row index. The
                editor keeps a flat list because EmailBison's sequence is flat
                and saving a nested shape would have to invent an ordering — but
                numbering the rows 1..N made a variant read as "step 4" of a
                3-step campaign. A variant shows which step it belongs to instead.
              */}
              <span
                className="tnum"
                style={{
                  flex: "none", fontSize: 12, padding: "2px 7px", borderRadius: 6,
                  background: step.variant ? "var(--blue-pale)" : "var(--inset)",
                  color: step.variant ? "var(--blue-ink)" : "var(--ink-2)",
                }}
              >
                {step.variant
                  ? `variant of ${steps.filter((s, i) => !s.variant && i < index).length}`
                  : steps.filter((s, i) => !s.variant && i <= index).length}
              </span>

              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : step.key)}
                aria-expanded={isOpen}
                style={{
                  minWidth: 0, flex: 1, textAlign: "left", border: 0, background: "none", font: "inherit",
                  fontSize: 13.5, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {step.email_subject || <em className="mut">Untitled step</em>}
              </button>

              {isNew ? <span className="badge s-done">new</span> : null}
              {variations > 1 ? (
                <span className="tnum mut" style={{ fontSize: 11.5, border: "1px solid var(--line)", borderRadius: 6, padding: "1px 5px", whiteSpace: "nowrap" }}>
                  {variations} variations
                </span>
              ) : null}

              <span style={{ display: "inline-flex", gap: 2, flex: "none" }}>
                <IconBtn label="Move step up" disabled={index === 0} onClick={() => move(index, -1)}>↑</IconBtn>
                <IconBtn label="Move step down" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>↓</IconBtn>
                <IconBtn
                  label="Remove step"
                  disabled={locked}
                  // The tooltip is the whole explanation: EmailBison refuses to
                  // delete a step that has sent, so the button can't work.
                  title={
                    locked
                      ? "This step has already sent emails — EmailBison will not delete it"
                      : "Remove this step"
                  }
                  danger
                  onClick={() => remove(index)}
                >
                  ✕
                </IconBtn>
              </span>
            </div>

            {isOpen ? (
              <div style={{ padding: 14, display: "grid", gap: 12 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
                  <label style={{ display: "block", flex: 1, minWidth: 240 }}>
                    <span className="as-l">Subject</span>
                    <input
                      className="inp"
                      value={step.email_subject}
                      onChange={(e) => update(index, { email_subject: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label style={{ display: "block", width: 130 }}>
                    {/*
                      EmailBison's own wording: wait_in_days is "how many days
                      before the sequence moves to the NEXT step" — a delay
                      AFTER this email, not before it. The first email goes out
                      as soon as the lead enters, so labelling this "Wait"
                      beside step 1 read as a delay before anything was sent.
                      The last step's value has nothing to gate and is inert.
                    */}
                    <span className="as-l">{index === steps.length - 1 ? "Wait (unused)" : "Then wait (days)"}</span>
                    <input
                      className="inp tnum"
                      type="number"
                      min={0}
                      value={step.wait_in_days}
                      onChange={(e) => update(index, { wait_in_days: Number(e.target.value) || 0 })}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", height: 40 }}>
                    <input
                      type="checkbox"
                      checked={step.thread_reply}
                      onChange={(e) => update(index, { thread_reply: e.target.checked })}
                      style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                    />
                    Reply in thread
                  </label>
                </div>

                {step.thread_reply ? (
                  // Otherwise the saved subject differs from what was typed and
                  // looks like the edit failed.
                  <div className="csince" style={{ marginTop: 0 }}>
                    EmailBison adds the &ldquo;Re: &rdquo; prefix to threaded steps — don&apos;t type it.
                  </div>
                ) : null}

                <div>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 7 }}>
                    <span className="as-l" style={{ marginBottom: 0 }}>Body</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {/*
                        §9.3: "Write the email with formatting." Wraps the
                        selection in HTML rather than editing rendered output —
                        the body carries spintax and merge tags in single braces
                        that a contenteditable surface would rewrite.
                      */}
                      <span style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                        {FORMATS.map((f) => (
                          <button
                            key={f.title}
                            type="button"
                            title={f.title}
                            aria-label={f.title}
                            onClick={() => wrap(index, f.open, f.close)}
                            style={{
                              width: 28, height: 26, border: 0, background: "var(--surface)", cursor: "pointer",
                              font: "inherit", fontSize: 12, color: "var(--ink-2)", ...f.style,
                            }}
                          >
                            {f.label}
                          </button>
                        ))}
                      </span>
                      <InsertFieldMenu tags={tags} onPick={(tag) => insertTag(index, tag)} />
                    </span>
                  </div>
                  <textarea
                    ref={(el) => {
                      bodyRefs.current[step.key] = el;
                    }}
                    className="inp"
                    value={step.email_body}
                    onChange={(e) => update(index, { email_body: e.target.value })}
                    rows={10}
                    spellCheck
                    style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: 1.6, resize: "vertical" }}
                  />
                  <div className="csince">
                    HTML and spintax (<code style={{ fontFamily: "var(--mono)" }}>{"{a|b}"}</code>) are both preserved as typed.
                  </div>
                </div>

                <div>
                  <span className="as-l">Preview</span>
                  <EmailPanel subject={step.email_subject} body={step.email_body} />
                </div>

                {/* §6.3: "Tag the copy's seven dimensions from the same screen." */}
                <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
                  <CopyTagsPanel
                    stepId={step.id ?? null}
                    subject={step.email_subject || null}
                    show={show}
                    isFirstEmail={index === 0 || step.variant}
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <div>
        <Btn onClick={add}>+ Add step</Btn>
      </div>

      {steps.some((s) => s.id != null && sent.has(s.id)) ? (
        <div className="csince" style={{ marginTop: 0 }}>
          Steps that have already sent emails cannot be removed — EmailBison refuses to delete
          them. They can still be edited and reordered.
        </div>
      ) : null}
    </div>
  );
}

function IconBtn({
  label,
  title,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 26, height: 26, border: 0, borderRadius: 6, background: "none", cursor: disabled ? "not-allowed" : "pointer",
        font: "inherit", fontSize: 13, color: danger ? "var(--red)" : "var(--muted)",
        ...(disabled ? DIM : null),
      }}
    >
      {children}
    </button>
  );
}

/** "Insert field" — the merge-tag menu, portalled so the card cannot clip it. */
function InsertFieldMenu({ tags, onPick }: { tags: string[]; onPick: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button"
        className="gh"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 12, padding: "4px 10px" }}
      >
        Insert field
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={260} align="end" label="Insert field">
        <div role="menu" style={{ padding: 6, maxHeight: 288, overflowY: "auto" }}>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(tag);
                close();
              }}
              style={{
                display: "block", width: "100%", textAlign: "left", border: 0, background: "none",
                padding: "6px 8px", borderRadius: 6, cursor: "pointer", font: "inherit",
                fontFamily: "var(--mono)", fontSize: 12,
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      </AnchoredPanel>
    </span>
  );
}
