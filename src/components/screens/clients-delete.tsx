"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";

/*
 * Deleting a client.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ASKS TWICE, AND SHOWS ITS WORKING
 *
 * This is the only irreversible thing in the workspace, and the row it sits on
 * looks exactly like thirty-six others. So: the button is quiet, the dialog
 * fetches and displays what would actually be removed BEFORE asking, and the
 * confirmation is the client's name typed out — not a checkbox, which is one
 * stray click.
 *
 * "Remove from the OS only" is the default and is reversible: the tools keep
 * their rows and the client can be adopted again. Master Inbox is never
 * included from here at all — its portal token is in a customer's hands.
 */

interface Plan {
  name: string;
  scope: "os" | "tools" | "everything";
  willDelete: string[];
  willKeep: string[];
  blocked: string | null;
  warnings: string[];
  destructive?: boolean;
  cascade?: {
    pipelineEntries: number; agents: number; dncEntries: number;
    teamMembers: number; threads: number;
  } | null;
}

export function DeleteClient({
  id,
  name,
  onDeleted,
}: {
  id: string;
  name: string;
  onDeleted: () => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ib"
        aria-label={`Remove ${name}`}
        title={`Remove ${name} from the workspace`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 26, height: 26, color: "var(--muted)" }}
      >
        ×
      </button>
      <ModalDialog
        open={open}
        onClose={close}
        width={400}
        label={`Remove ${name}`}
      >
        <DeleteBody id={id} name={name} onClose={close} onDeleted={onDeleted} />
      </ModalDialog>
    </>
  );
}

function DeleteBody({
  id, name, onClose, onDeleted,
}: { id: string; name: string; onClose: () => void; onDeleted: () => void }) {
  const [scope, setScope] = useState<"os" | "tools" | "everything">("os");
  // Separate from the name: typing a name carefully is not the same as knowing
  // what is inside the portal you are about to destroy.
  const [acceptLoss, setAcceptLoss] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Re-read whenever the scope changes: the consequences are different, and a
  // stale list is worse than none.
  useEffect(() => {
    let live = true;
    setPlan(null);
    fetch(`/api/workspace/clients/delete?id=${encodeURIComponent(id)}&scope=${scope}`)
      .then((r) => r.json())
      .then((p) => { if (live) setPlan(p as Plan); })
      .catch(() => { if (live) setError("Could not read what this would remove."); });
    return () => { live = false; };
  }, [id, scope]);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/workspace/clients/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, scope, confirm, acceptDataLoss: acceptLoss }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (body.failed?.length) {
        throw new Error(body.failed.map((f: { what: string; error: string }) => `${f.what}: ${f.error}`).join("; "));
      }
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    confirm.trim() === name.trim() &&
    !plan?.blocked &&
    // The acknowledgement gates the button too, not just the server.
    (scope !== "everything" || !plan?.destructive || acceptLoss);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 13.5 }}>Remove {name}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
          This cannot be undone.
        </div>
      </div>

      <div style={{ padding: 15, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 7 }}>
          {([
            ["os", "Remove from the OS list only", "Every tool keeps its row. Reversible — it can be adopted again."],
            ["tools", "Also delete from Analytics and Client Health", "Throws away attribution and billing history."],
            ["everything", "Delete everywhere, including the portal",
             "Removes the Master Inbox client. The portal URL stops working for good, and its pipeline, agents, DNC list and team go with it."],
          ] as const).map(([value, label, hint]) => (
            <label key={value} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, cursor: "pointer", lineHeight: 1.5 }}>
              <input
                type="radio"
                name={`scope-${id}`}
                checked={scope === value}
                onChange={() => setScope(value)}
                style={{ accentColor: value === "os" ? "var(--blue)" : "var(--red)", cursor: "pointer", marginTop: 2 }}
              />
              <span><b>{label}</b><br /><span className="mut">{hint}</span></span>
            </label>
          ))}
        </div>

        {plan?.blocked ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)", background: "var(--red-bg)", padding: "9px 11px", borderRadius: 8, lineHeight: 1.6 }}>
            {plan.blocked}
          </p>
        ) : null}

        {plan && !plan.blocked ? (
          <>
            <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <b>Will remove</b>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {plan.willDelete.map((d) => <li key={d}>{d}</li>)}
              </ul>
            </div>
            {plan.willKeep.length ? (
              <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                <b>Will keep</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
                  {plan.willKeep.map((k) => <li key={k}>{k}</li>)}
                </ul>
              </div>
            ) : null}
            {plan.warnings.map((w) => (
              <p key={w} style={{ margin: 0, fontSize: 12, color: "var(--yellow)", lineHeight: 1.6 }}>{w}</p>
            ))}
          </>
        ) : null}

        {scope === "everything" && plan?.destructive ? (
          <label style={{
            display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5,
            cursor: "pointer", lineHeight: 1.55, border: "1px solid var(--red)",
            background: "var(--red-bg)", borderRadius: 8, padding: "9px 11px",
          }}>
            <input
              type="checkbox"
              checked={acceptLoss}
              onChange={(e) => setAcceptLoss(e.target.checked)}
              style={{ accentColor: "var(--red)", cursor: "pointer", marginTop: 2 }}
            />
            <span>
              I understand this portal has real content
              {plan.cascade ? (
                <>
                  {" "}— {plan.cascade.pipelineEntries} pipeline entries,{" "}
                  {plan.cascade.agents} agents, {plan.cascade.dncEntries} DNC entries,{" "}
                  {plan.cascade.teamMembers} team members
                </>
              ) : null}
              {" "}and that all of it will be destroyed.
            </span>
          </label>
        ) : null}

        <label style={{ display: "grid", gap: 5 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
            Type <b>{name}</b> to confirm
          </span>
          <input className="inp" value={confirm} placeholder={name} onChange={(e) => setConfirm(e.target.value)} />
        </label>

        {error ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--line-soft)", flex: "none" }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-pri"
          style={{ flex: 2, background: "var(--red)", boxShadow: "none" }}
          disabled={!ready || busy}
          onClick={() => void run()}
        >
          {busy
            ? "Removing…"
            : scope === "everything"
              ? "Delete everywhere, portal included"
              : scope === "tools"
                ? "Delete from the tools"
                : "Remove from the OS"}
        </button>
      </div>
    </div>
  );
}
