"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

interface ToolDescriptor {
  id: string;
  label: string;
  description: string;
}

interface TeamUser {
  email: string;
  grants: string[];
  isActive: boolean;
  isAdmin: boolean;
  role: string;
  isSelf: boolean;
}

interface TeamPayload {
  users: TeamUser[];
  tools: ToolDescriptor[];
  capabilities: { writable: boolean; editable?: boolean; reason: string };
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

  const toggle = useCallback((email: string, tool: string) => {
    setPreview(null);
    setCopied(false);
    setDraft((d) => {
      const current = d[email] ?? [];
      return {
        ...d,
        [email]: current.includes(tool)
          ? current.filter((t) => t !== tool)
          : [...current, tool],
      };
    });
  }, []);

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
        <button className="btn btn-pri" disabled title="Adding people needs the grants database">
          + Invite teammate
        </button>
      </div>

      {/*
       * The bootstrap fail-open, said out loud. Without this the screen would
       * show everyone holding every tool and look like a deliberate choice,
       * when in fact no policy has been set at all.
       */}
      {!data.governance.grantsGoverned ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>No access policy is set yet.</b> BS_GRANTS is empty, so everyone who can sign
          in currently has every tool. Set the switches below and apply the generated
          configuration to make this list authoritative.
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
                    <div className="cname">{user.email.split("@")[0]}</div>
                    <div className="csince">
                      {user.email}
                      {user.isAdmin ? ` · ${user.role}` : ""}
                    </div>
                  </td>
                  {data.tools.map((tool) => {
                    const on = (draft[user.email] ?? []).includes(tool.id);
                    return (
                      <td key={tool.id}>
                        <button
                          className={`tg${on ? " on" : ""}`}
                          aria-pressed={on}
                          aria-label={`${tool.label} for ${user.email}`}
                          onClick={() => toggle(user.email, tool.id)}
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
        <button className="btn btn-pri" onClick={generate} disabled={!dirty || busy}>
          {busy ? "Generating…" : "Generate configuration"}
        </button>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          {dirty
            ? "Switches changed — generate the value to apply."
            : "No changes yet."}
        </span>
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
