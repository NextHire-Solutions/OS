"use client";

import { useState } from "react";

import type { Template, TemplateList } from "@/lib/tools/onboarding/templates";
import {
  TEMPLATE_SECTIONS,
  isSystemTemplate,
  mergeFieldsIn,
} from "@/lib/tools/onboarding/template-types";
import { PlaceholderScreen } from "../lazy";
import {
  TEMPLATES_URL,
  createTemplate,
  removeTemplate,
  saveTemplate,
  useOnboardingData,
} from "./actions";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Onboarding — templates.
 *
 * A port of the orchestrator's `/templates` page (app/templates/page.tsx +
 * components/TemplateEditor.tsx + components/AddTemplate.tsx), rebuilt in the
 * workspace's own classes.
 *
 * These rows ARE what the orchestrator sends. It looks a template up by key at
 * the moment it needs it, so an edit here takes effect on the next send — there
 * is no copy and no deploy in between. That is also why the nine templates the
 * automation sends cannot be deleted: the send would fail at the moment it
 * mattered, with nothing on screen to explain why.
 */

export function OnboardingTemplatesScreen({ initial }: { initial: TemplateList | null }) {
  const { data, error, reload } = useOnboardingData<TemplateList>(initial, TEMPLATES_URL);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Templates could not be loaded.</b> {error}
        </div>
      </div>
    );
  }
  if (!data) return <PlaceholderScreen cards={3} />;
  return <TemplatesView list={data} reload={reload} />;
}

function TemplatesView({ list, reload }: { list: TemplateList; reload: () => Promise<void> }) {
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      show({ text: what });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (list.error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Onboarding could not be read.</b> {list.error}. The orchestrator itself is
          unaffected — this is the workspace&rsquo;s connection to its database.
        </div>
      </div>
    );
  }

  const templates = list.templates;
  const system = templates.filter((t) => isSystemTemplate(t.key)).length;

  return (
    <div className="wrap">
      <div className="cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="card">
          <div className="card-l">Templates</div>
          <div className="card-n tnum">{templates.length}</div>
          <div className="card-s">across {TEMPLATE_SECTIONS.length} categories</div>
        </div>
        <div className="card">
          <div className="card-l">Sent by automation</div>
          <div className="card-n tnum n-blue">{system}</div>
          <div className="card-s">editable, not deletable</div>
        </div>
        <div className="card">
          <div className="card-l">Takes effect</div>
          <div className="card-n" style={{ fontSize: 22 }}>
            Next send
          </div>
          <div className="card-s">no deploy in between</div>
        </div>
      </div>

      {TEMPLATE_SECTIONS.map(({ cat, label, hint }) => {
        const items = templates.filter((t) => t.category === cat);
        return (
          <div className="tbl-wrap" key={cat}>
            <div className="tbl-head">
              <div>
                <div className="tbl-title">
                  {label}{" "}
                  <span className="mut" style={{ fontWeight: 500, fontSize: 13.5 }}>
                    ({items.length})
                  </span>
                </div>
                <div className="tbl-sub">{hint}</div>
              </div>
              <Btn
                disabled={busy}
                onClick={() => void run("Template added", () => createTemplate(cat))}
              >
                + New template
              </Btn>
            </div>

            <div style={{ padding: "4px 22px 18px" }}>
              {items.length === 0 ? (
                <div style={{ padding: "26px 0", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
                  No templates in this category yet.
                </div>
              ) : (
                items.map((t) => <Editor key={t.id} t={t} busy={busy} run={run} />)
              )}
            </div>
          </div>
        );
      })}

      <Toast toast={toast} />
    </div>
  );
}

function Editor({
  t,
  busy,
  run,
}: {
  t: Template;
  busy: boolean;
  run: (what: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(t.name);
  const [subject, setSubject] = useState(t.subject ?? "");
  const [body, setBody] = useState(t.body);

  const dirty = name !== t.name || subject !== (t.subject ?? "") || body !== t.body;
  const locked = isSystemTemplate(t.key);
  const fields = mergeFieldsIn(`${subject}\n${body}`);

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        padding: 14,
        marginTop: 12,
        background: dirty ? "var(--inset)" : "var(--surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Btn
          aria-expanded={open}
          aria-label={open ? `Collapse ${t.name}` : `Expand ${t.name}`}
          title={open ? "Collapse" : "Expand to edit the wording"}
          style={{ padding: "6px 12px", minWidth: 38 }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "−" : "+"}
        </Btn>

        <input
          className="inp"
          value={name}
          disabled={busy}
          aria-label={`Name of ${t.name}`}
          placeholder="Template name"
          style={{ flex: 1, minWidth: 200 }}
          onChange={(e) => setName(e.target.value)}
        />

        {t.key && (
          <span
            className="mut"
            title={
              locked
                ? "The automation sends this template by this key — it can be reworded but not deleted."
                : "The key this template is looked up by."
            }
            style={{ fontFamily: "var(--mono)", fontSize: 11.5, whiteSpace: "nowrap" }}
          >
            {t.key}
          </span>
        )}

        {dirty && (
          <span className="badge s-pending">
            <span className="dot" />
            unsaved
          </span>
        )}

        <Btn
          primary
          disabled={busy || !dirty}
          onClick={() =>
            void run(`Saved “${name}”`, () => saveTemplate(t.id, { name, subject, body }))
          }
        >
          Save
        </Btn>

        {dirty && (
          <Btn
            disabled={busy}
            onClick={() => {
              setName(t.name);
              setSubject(t.subject ?? "");
              setBody(t.body);
            }}
          >
            Cancel
          </Btn>
        )}

        {locked ? (
          /*
           * Not a disabled Delete: a greyed button invites clicking to find out
           * why. The server refuses this too — the rule lives in
           * lib/tools/onboarding/templates.ts, not only here.
           */
          <span
            className="badge s-done"
            title="The automation sends this one. Edit its wording instead of deleting it."
          >
            <span className="dot" />
            automation
          </span>
        ) : (
          <ConfirmButton
            label="Delete"
            armedLabel="Confirm delete"
            title={`Delete template “${t.name}”?`}
            disabled={busy}
            onConfirm={() => void run(`Deleted “${t.name}”`, () => removeTemplate(t.id))}
          />
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          {t.category === "email" && (
            <label style={{ display: "block" }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--ink-2)",
                  marginBottom: 7,
                  fontWeight: 500,
                }}
              >
                Subject
              </span>
              <input
                className="inp"
                value={subject}
                disabled={busy}
                style={{ width: "100%" }}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
          )}

          <label style={{ display: "block" }}>
            <span
              style={{
                display: "block",
                fontSize: 13,
                color: "var(--ink-2)",
                marginBottom: 7,
                fontWeight: 500,
              }}
            >
              Body
            </span>
            <textarea
              className="inp"
              value={body}
              disabled={busy}
              rows={14}
              style={{
                width: "100%",
                minHeight: 200,
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                lineHeight: 1.6,
                resize: "vertical",
              }}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
            {fields.length > 0 ? (
              <>
                Merge fields in this template, filled at send time:{" "}
                {fields.map((f) => (
                  <span
                    key={f}
                    className="pill mut"
                    style={{ marginRight: 5, fontFamily: "var(--mono)" }}
                  >
                    {`{{${f}}}`}
                  </span>
                ))}
              </>
            ) : (
              <>
                No merge fields. Ones like <code>{"{{firstName}}"}</code>,{" "}
                <code>{"{{Sender Name}}"}</code> and <code>{"{{Brokerage Name}}"}</code> are filled
                at send time; spacing and capitalisation do not matter.
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
