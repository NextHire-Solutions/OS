"use client";

import { useEffect, useRef, useState } from "react";

import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  formatFieldHref,
  validateField,
  type ClientField,
  type FieldType,
} from "@/lib/tools/onboarding/client-field-types";
import type { MlsOption } from "@/lib/tools/onboarding/client-leads";
import {
  addClientField,
  lookupMls,
  patchClient,
  removeClientField,
  updateClientField,
} from "./actions";
import { Btn, ConfirmButton } from "./toast";

/*
 * The two editable things in the middle of a client's profile: the MLS they
 * recruit in, and the team's own custom fields.
 *
 * Ported from the orchestrator's `components/MlsPicker.tsx` and
 * `components/CustomFields.tsx`. Both write to `orch_clients` /
 * `orch_client_fields` and reach nothing outside this database.
 *
 * The tool guarded its field delete with `window.confirm`. That is the wrong
 * control here twice over — a native dialog is a jarring break from a screen
 * that is otherwise the workspace's own, and it suspends the page in a way no
 * automated check can drive, so a delete guarded by it is a delete no test can
 * prove works. `ConfirmButton` arms on the first click and fires on the second,
 * carrying the tool's own warning in `title`.
 */

type Notify = (text: string, bad?: boolean) => void;

/* ============================== MLS PICKER =============================== */

/**
 * The MLS a client recruits in — one or several.
 *
 * They pick from the `mls` table rather than typing: the code has to match for
 * the lead search to find anything, and a typo would build an empty list without
 * complaining. Saving changes nothing else; the lead list is rebuilt by hand
 * afterwards, like every other step.
 */
export function MlsPicker({
  clientId,
  current,
  notify,
  onSaved,
}: {
  clientId: string;
  current: string[];
  notify: Notify;
  onSaved: () => Promise<void>;
}) {
  const [codes, setCodes] = useState(current);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<MlsOption[]>([]);
  const [busy, setBusy] = useState(false);
  // Guards a setState after unmount while a slow lookup is in flight.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The server row is the truth: after a reload, take whatever it now says.
  useEffect(() => setCodes(current), [current]);

  async function save(next: string[]) {
    setBusy(true);
    setTerm("");
    setHits([]);
    try {
      await patchClient(clientId, { mls: next });
      setCodes(next);
      await onSaved();
      notify(next.length ? `MLS saved — ${next.join(", ")}` : "MLS cleared");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not save the MLS", true);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function search(q: string) {
    setTerm(q);
    const found = await lookupMls(q);
    if (live.current) setHits(found);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {codes.map((c) => (
          <span
            key={c}
            className="badge s-done"
            style={{ paddingRight: 6, background: "var(--blue-pale)", color: "var(--blue-ink)" }}
          >
            {c}
            <button
              type="button"
              aria-label={`Remove ${c}`}
              title={`Remove ${c}`}
              disabled={busy}
              onClick={() => save(codes.filter((x) => x !== c))}
              style={{
                border: 0,
                background: "none",
                font: "inherit",
                fontWeight: 700,
                cursor: busy ? "not-allowed" : "pointer",
                color: "inherit",
                opacity: busy ? 0.4 : 0.65,
                /*
                 * `padding: "0 2px"` made this a 12x18 target — small enough to
                 * miss, and it removes an MLS code from a client. The negative
                 * margin keeps the chip exactly the size it was, so only the
                 * hit area grows.
                 */
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 22,
                minHeight: 22,
                margin: "-4px -4px -4px 0",
                borderRadius: 6,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {codes.length === 0 && <span className="api-none">no MLS set</span>}
      </div>

      <div style={{ position: "relative" }}>
        <input
          className="inp"
          type="text"
          value={term}
          disabled={busy}
          placeholder="Add an MLS — type a code or name…"
          aria-label="Search the MLS list"
          onChange={(e) => search(e.target.value)}
          style={{ width: "100%", minWidth: 0 }}
        />
        {hits.length > 0 && (
          <div
            style={{
              position: "absolute",
              zIndex: 20,
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              maxHeight: 240,
              overflowY: "auto",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-md)",
              boxShadow: "var(--sh-raise)",
            }}
          >
            {hits
              .filter((h) => !codes.includes(h.code))
              .map((h) => (
                <button
                  key={h.code}
                  type="button"
                  onClick={() => save([...codes, h.code])}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    border: 0,
                    background: "none",
                    font: "inherit",
                    fontSize: 13.5,
                    padding: "9px 13px",
                    cursor: "pointer",
                    color: "var(--ink)",
                  }}
                >
                  <b>{h.code}</b> <span className="mut">{h.name}</span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================ CUSTOM FIELDS ============================== */

function FieldRow({
  clientId,
  field,
  first,
  last,
  notify,
  onSaved,
}: {
  clientId: string;
  field: ClientField;
  first: boolean;
  last: boolean;
  notify: Notify;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const href = field.value ? formatFieldHref(field.type, field.value) : null;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      await onSaved();
      notify(ok);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not save that field", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 200px) 1fr",
        gap: 10,
        alignItems: "center",
        padding: "9px 0",
        borderTop: first ? undefined : "1px solid var(--line-soft)",
      }}
    >
      {editing ? (
        <input
          className="inp"
          type="text"
          defaultValue={field.label}
          disabled={busy}
          aria-label={`Name of the ${field.label} field`}
          style={{ minWidth: 0, width: "100%" }}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== field.label) run(() => updateClientField(clientId, field.id, { label: next }), `Renamed to “${next}”`);
          }}
        />
      ) : (
        <span style={{ fontSize: 13.5, color: "var(--muted)", fontWeight: 500 }}>{field.label}</span>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {editing && (
          <select
            className="sel"
            defaultValue={field.type}
            disabled={busy}
            aria-label={`Type of the ${field.label} field`}
            onChange={(e) =>
              run(
                () => updateClientField(clientId, field.id, { type: e.target.value as FieldType }),
                `${field.label} is now a ${FIELD_TYPE_LABELS[e.target.value as FieldType].toLowerCase()}`,
              )
            }
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        )}

        <input
          className="inp"
          type={field.type === "date" ? "date" : "text"}
          defaultValue={field.value ?? ""}
          placeholder={FIELD_TYPE_LABELS[field.type].toLowerCase()}
          disabled={busy}
          aria-label={`${field.label} value`}
          style={{ flex: 1, minWidth: 150 }}
          onBlur={(e) => {
            const next = e.target.value;
            if (next.trim() !== (field.value ?? "")) {
              run(() => updateClientField(clientId, field.id, { value: next }), `${field.label} saved`);
            }
          }}
        />

        {href && !editing && (
          <a
            href={href}
            target={field.type === "url" ? "_blank" : undefined}
            rel="noopener noreferrer"
            title={`Open ${field.label}`}
            style={{ fontSize: 13, color: "var(--blue)", fontWeight: 600, whiteSpace: "nowrap" }}
          >
            open ↗
          </a>
        )}

        {editing ? (
          <>
            <Btn
              disabled={busy || first}
              title="Move up"
              aria-label={`Move ${field.label} up`}
              onClick={() => run(() => updateClientField(clientId, field.id, { move: "up" }), `${field.label} moved up`)}
            >
              ↑
            </Btn>
            <Btn
              disabled={busy || last}
              title="Move down"
              aria-label={`Move ${field.label} down`}
              onClick={() => run(() => updateClientField(clientId, field.id, { move: "down" }), `${field.label} moved down`)}
            >
              ↓
            </Btn>
            <ConfirmButton
              label="Delete"
              armedLabel="Delete for good"
              title={`Deletes "${field.label}" from this client. Nothing automatic reads custom fields, so nothing else changes.`}
              disabled={busy}
              onConfirm={() => run(() => removeClientField(clientId, field.id), `${field.label} deleted`)}
            />
            <Btn disabled={busy} onClick={() => setEditing(false)}>
              Done
            </Btn>
          </>
        ) : (
          <Btn disabled={busy} onClick={() => setEditing(true)} aria-label={`Edit the ${field.label} field`}>
            Edit
          </Btn>
        )}
      </div>
    </div>
  );
}

/**
 * The team's own fields on a client — a website, a contract link, a second
 * phone. Separate from the built-in details above them, which the automation
 * depends on; nothing automatic reads these, which is what makes them safe to
 * add and delete at will.
 */
export function CustomFields({
  clientId,
  fields,
  knownLabels,
  notify,
  onSaved,
}: {
  clientId: string;
  fields: ClientField[];
  knownLabels: string[];
  notify: Notify;
  onSaved: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Checked here as well as on the server, so the obvious typo is caught before
  // the round trip rather than after it.
  const localError = value.trim() ? validateField(type, value) : null;

  async function add() {
    if (!label.trim() || localError) return;
    setBusy(true);
    try {
      await addClientField(clientId, label.trim(), type, value);
      await onSaved();
      notify(`Added “${label.trim()}”`);
      setLabel("");
      setValue("");
      setType("text");
      setAdding(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not add that field", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {fields.length > 0 && (
        <div>
          {fields.map((f, i) => (
            <FieldRow
              key={f.id}
              clientId={clientId}
              field={f}
              first={i === 0}
              last={i === fields.length - 1}
              notify={notify}
              onSaved={onSaved}
            />
          ))}
        </div>
      )}

      {adding ? (
        <div style={{ display: "grid", gap: 8, marginTop: fields.length ? 14 : 0 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              list="onb-known-field-labels"
              type="text"
              placeholder="Field name, e.g. Website"
              aria-label="New field name"
              value={label}
              disabled={busy}
              style={{ flex: 1, minWidth: 150 }}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            {/* Labels already in use anywhere, so adding "Website" to a second
                client is a pick rather than a retype. */}
            <datalist id="onb-known-field-labels">
              {knownLabels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <select
              className="sel"
              value={type}
              disabled={busy}
              aria-label="New field type"
              onChange={(e) => setType(e.target.value as FieldType)}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="inp"
              type={type === "date" ? "date" : "text"}
              placeholder="Value (can be filled in later)"
              aria-label="New field value"
              value={value}
              disabled={busy}
              style={{ flex: 1, minWidth: 170 }}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <Btn primary disabled={busy || !label.trim() || !!localError} onClick={add}>
              Add field
            </Btn>
            <Btn
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setLabel("");
                setValue("");
              }}
            >
              Cancel
            </Btn>
          </div>
          {localError && (
            <span style={{ fontSize: 13, color: "var(--red)" }}>{localError}</span>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: fields.length ? 14 : 0, flexWrap: "wrap" }}>
          <Btn onClick={() => setAdding(true)}>Add a field</Btn>
          {fields.length === 0 && (
            <span className="tbl-sub">
              Anything you want to keep on this client — a website, a contract link, a second
              phone. Nothing automatic reads them.
            </span>
          )}
        </div>
      )}
    </>
  );
}
