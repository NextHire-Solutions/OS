"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/ui/modal-dialog";

/*
 * Team access — who may open which tool.
 *
 * ---------------------------------------------------------------------------
 * THE SWITCHES EDIT, THEY DO NOT SAVE
 *
 * Grants live in the BS_GRANTS environment variable, which a running process
 * cannot write to. Rather than accept a click, return 200 and have it vanish on
 * the next request, the toggles change local state and the screen shows the
 * exact value to paste into Railway.
 *
 * That is the whole reason this screen is honest: someone flipping a switch,
 * believing access changed and being wrong about who can read the inbox is far
 * worse than a switch that says what it actually does. The banner and the
 * button both say "generate", never "save".
 *
 * When the grants table lands, `capabilities.writable` flips to true upstream
 * and a save button replaces the generator. Nothing else here changes.
 */

/* A text link that is a button: the row actions, which change data. */
const LINK_BUTTON = { background: "none", border: 0, padding: 0, color: "var(--blue)", cursor: "pointer", font: "inherit" } as const;

interface ToolDescriptor {
  id: string;
  label: string;
  description: string;
}

interface TeamUser {
  email: string;
  name: string | null;
  /** "env" = AUTH_USERS (managed in Railway); "db" = invited from this screen. */
  source: "env" | "db";
  grants: string[];
  isActive: boolean;
  isAdmin: boolean;
  role: string;
  isSelf: boolean;
}

interface TeamPayload {
  users: TeamUser[];
  tools: ToolDescriptor[];
  capabilities: { writable: boolean; canInvite?: boolean; inviteReason?: string | null; editable?: boolean; reason: string };
  governance: {
    grantsGoverned: boolean;
    adminsGoverned: boolean;
    store: string;
    userCount: number;
  };
}

interface PreviewPayload {
  variable: string;
  value: string;
  changed: { email: string; from: string[]; to: string[] }[];
  warnings: { level: "danger" | "caution"; message: string }[];
  unchanged: boolean;
  instructions: string[];
}

export function TeamAccessScreen() {
  const [data, setData] = useState<TeamPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        return res.json() as Promise<TeamPayload>;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setDraft(Object.fromEntries(payload.users.map((u) => [u.email, [...u.grants]])));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load"));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!data) return false;
    return data.users.some((u) => {
      const next = draft[u.email] ?? [];
      return next.length !== u.grants.length || u.grants.some((g) => !next.includes(g));
    });
  }, [data, draft]);

  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  /** A freshly minted temporary password, shown once for one person. */
  const [handover, setHandover] = useState<{ email: string; password: string; kind: "invited" | "reset" } | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (!res.ok) return;
    const payload = (await res.json()) as TeamPayload;
    setData(payload);
    setDraft(Object.fromEntries(payload.users.map((u) => [u.email, [...u.grants]])));
  }, []);

  const personAction = useCallback(async (email: string, body: { active?: boolean; resetPassword?: true }) => {
    setSaveError(null);
    setSaving(`${email}:person`);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, ...body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      if (typeof out.temporaryPassword === "string") setHandover({ email, password: out.temporaryPassword, kind: "reset" });
      await reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(null);
    }
  }, [reload]);

  const toggle = useCallback((email: string, tool: string) => {
    setPreview(null);
    setCopied(false);
    setSaveError(null);
    const current = draft[email] ?? [];
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool];
    setDraft((d) => ({ ...d, [email]: next }));

    /*
     * When the grants table is in use, a switch IS the save. Optimistic, and
     * reverted with the server's reason if it fails — a switch that looks on
     * while access is still off is the one outcome this screen must not
     * produce. Without the table the old generate-and-paste path remains.
     */
    if (!data?.capabilities.writable) return;
    setSaving(`${email}:${tool}`);
    fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, grants: next }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
        // Make the saved state the new baseline so `dirty` stays false.
        setData((d) => d ? { ...d, users: d.users.map((u) => u.email === email ? { ...u, grants: next } : u) } : d);
      })
      .catch((e) => {
        setDraft((d) => ({ ...d, [email]: current }));
        setSaveError(e instanceof Error ? e.message : "Could not save");
      })
      .finally(() => setSaving(null));
  }, [draft, data]);

  const generate = useCallback(async () => {
    setBusy(true);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/grants/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          users: Object.entries(draft).map(([email, grants]) => ({ email, grants })),
        }),
      });
      setPreview(await res.json());
    } catch {
      setError("Could not generate the configuration.");
    } finally {
      setBusy(false);
    }
  }, [draft]);

  if (error) {
    return (
      <div className="wrap" style={{ maxWidth: 1000 }}>
        <div className="card">
          <div className="card-l">Team access</div>
          <p style={{ fontSize: 14, color: "var(--muted)" }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="wrap" style={{ maxWidth: 1000 }}>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>Loading team access…</p>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ maxWidth: 1000 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.01em" }}>Team access</h1>
          <p style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 4 }}>
            Switch a tool on to give that person access.
          </p>
        </div>
        <span className="spacer" />
        <button
          className="btn btn-pri"
          disabled={!data.capabilities.canInvite}
          title={data.capabilities.canInvite ? undefined : (data.capabilities.inviteReason ?? "Inviting needs the users table")}
          onClick={() => setInviteOpen(true)}
        >
          + Invite teammate
        </button>
      </div>

      {!data.capabilities.canInvite ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Inviting is not switched on yet.</b> {data.capabilities.inviteReason}
        </div>
      ) : null}

      <ModalDialog open={inviteOpen} onClose={() => setInviteOpen(false)} width={620} label="Invite a teammate">
        <InviteForm
          tools={data.tools}
          onClose={() => setInviteOpen(false)}
          onInvited={async (email, password) => {
            setInviteOpen(false);
            setHandover({ email, password, kind: "invited" });
            await reload();
          }}
        />
      </ModalDialog>

      <ModalDialog open={handover !== null} onClose={() => setHandover(null)} width={520} label="Temporary password">
        {handover ? <Handover {...handover} onDone={() => setHandover(null)} /> : null}
      </ModalDialog>

      {/*
       * The bootstrap fail-open, said out loud. Without this the screen would
       * show everyone holding every tool and look like a deliberate choice,
       * when in fact no policy has been set at all.
       */}
      {!data.governance.grantsGoverned ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>No access policy is set yet.</b> Everyone who can sign in currently has every
          tool.{" "}
          {data.capabilities.writable
            ? "Switch a tool off below and it saves immediately."
            : "Set the switches below and apply the generated configuration to make this list authoritative."}
        </div>
      ) : null}

      <div className="tbl-wrap">
        <div className="tbl-scroll">
          <table className="acc-tbl">
            <thead>
              <tr>
                <th>Person</th>
                {data.tools.map((t) => (
                  <th key={t.id}>{t.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr key={user.email}>
                  <td>
                    <div className="cname" style={{ opacity: user.isActive ? 1 : 0.55 }}>
                      {user.name ?? user.email.split("@")[0]}
                      {!user.isActive ? <span className="csince" style={{ marginLeft: 8 }}>deactivated</span> : null}
                    </div>
                    <div className="csince">
                      {user.email}
                      {user.isAdmin ? ` · ${user.role} · every tool, always` : ""}
                      {user.source === "env" && !user.isAdmin ? " · from AUTH_USERS" : ""}
                    </div>
                    {user.source === "db" && !user.isSelf && data.capabilities.canInvite ? (
                      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                        <button
                          type="button"
                          style={{ ...LINK_BUTTON, fontSize: 12.5 }}
                          disabled={saving === `${user.email}:person`}
                          onClick={() => personAction(user.email, { resetPassword: true })}
                        >
                          New temporary password
                        </button>
                        <button
                          type="button"
                          style={{ ...LINK_BUTTON, fontSize: 12.5, color: user.isActive ? "var(--red)" : "var(--blue)" }}
                          disabled={saving === `${user.email}:person`}
                          onClick={() => personAction(user.email, { active: !user.isActive })}
                        >
                          {user.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    ) : null}
                  </td>
                  {data.tools.map((tool) => {
                    const on = user.isAdmin || (draft[user.email] ?? []).includes(tool.id);
                    return (
                      <td key={tool.id}>
                        {/* An Owner holds every tool, always — the switch is a
                            statement, not a control. */}
                        <button
                          className={`tg${on ? " on" : ""}`}
                          aria-pressed={on}
                          aria-label={`${tool.label} for ${user.email}${user.isAdmin ? " (always on for an Owner)" : ""}`}
                          disabled={user.isAdmin}
                          title={user.isAdmin ? "Owners always have every tool" : undefined}
                          style={user.isAdmin ? { cursor: "default", opacity: 0.85 } : undefined}
                          onClick={() => { if (!user.isAdmin) toggle(user.email, tool.id); }}
                        >
                          <i />
                          {on ? "On" : "Off"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
        {data.capabilities.writable ? (
          <span style={{ fontSize: 13, color: saveError ? "var(--red)" : "var(--muted)" }}>
            {saveError
              ? `Not saved — ${saveError}`
              : saving
                ? "Saving…"
                : "Switches save as you click them. Access updates as each person's session refreshes, within 30 minutes."}
          </span>
        ) : (
          <>
            <button className="btn btn-pri" onClick={generate} disabled={!dirty || busy}>
              {busy ? "Generating…" : "Generate configuration"}
            </button>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              {dirty ? "Switches changed — generate the value to apply." : "No changes yet."}
            </span>
          </>
        )}
      </div>

      {preview ? <Preview preview={preview} copied={copied} onCopied={setCopied} /> : null}
    </div>
  );
}

function Preview({
  preview,
  copied,
  onCopied,
}: {
  preview: PreviewPayload;
  copied: boolean;
  onCopied: (v: boolean) => void;
}) {
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-l">Apply this change</div>

      {/* Warnings first, above the value — after someone has copied and
          redeployed is far too late to mention a locked-out teammate. */}
      {preview.warnings.map((w, i) => (
        <div
          key={i}
          className="anno"
          style={{
            margin: "0 0 12px",
            ...(w.level === "danger"
              ? { background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }
              : {}),
          }}
        >
          <b>{w.level === "danger" ? "Careful — " : "Note — "}</b>
          {w.message}
        </div>
      ))}

      {preview.changed.length > 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 12 }}>
          {preview.changed.map((c) => (
            <div key={c.email} style={{ marginBottom: 4 }}>
              <b>{c.email}</b>: {c.from.length ? c.from.join(", ") : "no tools"} →{" "}
              {c.to.length ? c.to.join(", ") : "no tools"}
            </div>
          ))}
        </div>
      ) : null}

      <pre
        style={{
          background: "var(--inset)",
          borderRadius: "var(--r-md)",
          padding: "14px 16px",
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          lineHeight: 1.7,
          overflowX: "auto",
          margin: "0 0 12px",
          color: "var(--ink)",
        }}
      >
        {preview.variable}={"\n"}
        {preview.value}
      </pre>

      <button
        className="btn"
        onClick={() => {
          navigator.clipboard?.writeText(preview.value).then(
            () => onCopied(true),
            () => onCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy value"}
      </button>

      <ol style={{ fontSize: 13, color: "var(--muted)", margin: "14px 0 0 18px", lineHeight: 1.7 }}>
        {preview.instructions.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

/*
 * Invite: name, email, and the tools the person starts with. The OS mints the
 * temporary password server-side and returns it once; nothing is emailed, so
 * the admin hands it over themselves. That is deliberate — the OS never sends
 * mail on anyone's behalf without an explicit decision to do so.
 */
const FIELD: React.CSSProperties = { display: "grid", gap: 5 };
const LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };

function InviteForm({
  tools,
  onClose,
  onInvited,
}: {
  tools: ToolDescriptor[];
  onClose: () => void;
  onInvited: (email: string, temporaryPassword: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && grants.length > 0;

  async function submit() {
    setBusy(true);
    setFailed("");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), grants }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      await onInvited(out.email, out.temporaryPassword);
      setName(""); setEmail(""); setGrants([]);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Could not invite");
    } finally {
      setBusy(false);
    }
  }

  // The same frame as "Onboard a client": a titled header, a padded body, a
  // footer with the two actions — so the two dialogs read as one family.
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>Invite a teammate</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          They sign in at os.brokerstaffer.com with a temporary password you hand them. Nothing is emailed.
        </div>
      </div>

      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <label style={FIELD}>
            <span style={LABEL}>Name</span>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Nicole Rivera" autoFocus />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Email *</span>
            <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nicole@brokerstaffer.com" />
          </label>
        </div>

        <div style={FIELD}>
          <span style={LABEL}>Tools they can open *</span>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {tools.map((t) => {
              const on = grants.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${t.label} for the new teammate`}
                  onClick={() => setGrants((g) => (on ? g.filter((x) => x !== t.id) : [...g, t.id]))}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                    padding: "10px 12px", borderRadius: "var(--r-md)", cursor: "pointer", font: "inherit",
                    border: `1px solid ${on ? "var(--blue)" : "var(--line)"}`,
                    background: on ? "var(--blue-bg, var(--inset))" : "var(--surface)",
                  }}
                >
                  <span className={`tg${on ? " on" : ""}`} aria-hidden style={{ pointerEvents: "none" }}>
                    <i />
                    {on ? "On" : "Off"}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{t.label}</span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {failed ? <div style={{ fontSize: 13, color: "var(--red)" }}>{failed}</div> : null}
      </div>

      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flex: "none" }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-pri" style={{ flex: 1 }} onClick={submit} disabled={!valid || busy}>
          {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
    </div>
  );
}

/* The one-time handover. Once this closes the password is gone for good. */
function Handover({ email, password, kind, onDone }: { email: string; password: string; kind: "invited" | "reset"; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>{kind === "invited" ? "Teammate invited" : "New temporary password"}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          {kind === "invited"
            ? <><b style={{ color: "var(--ink)" }}>{email}</b> can sign in at os.brokerstaffer.com with this password.</>
            : <>For <b style={{ color: "var(--ink)" }}>{email}</b>. Their previous sessions are signed out.</>}
        </div>
      </div>
      <div style={{ padding: 16, display: "grid", gap: 12 }}>
        <pre
          className="tnum"
          style={{ fontSize: 20, letterSpacing: ".06em", textAlign: "center", padding: "14px 16px", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", margin: 0, userSelect: "all", overflowX: "auto" }}
        >
          {password}
        </pre>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>
          Shown once — it is not stored anywhere readable. If it is lost, issue a new one from the person&rsquo;s row.
        </p>
      </div>
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flex: "none" }}>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => navigator.clipboard?.writeText(password).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? "Copied" : "Copy password"}
        </button>
        <button type="button" className="btn btn-pri" style={{ flex: 1 }} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
