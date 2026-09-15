"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Checkbox } from "@/components/mi-ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { Btn, Field, Section, ToastHost, useShowToast } from "./ui";

/*
 * Members.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED
 *
 * Two Tailwind `<section>`s become two of the design's cards; the members list
 * becomes a `.tbl-wrap` + `.atbl`; the role becomes the design's `.plan` chip.
 * The invite POST, the password generator, the workspace-selection rules, the
 * per-email grouping and the reset dialog are the code that was already here.
 *
 * One fix: every message went to `sonner`, whose `<Toaster />` this app never
 * mounts — so inviting a teammate has been silently succeeding and silently
 * failing since the port. They go to the workspace's own status line now, which
 * is both visible and readable by a test.
 */

interface Workspace {
  id: string;
  name: string;
  emailbison_team_id: number | null;
}

interface Member {
  id: string;
  role: string;
  status: string;
  workspace_id: string;
  user_id: string | null;
  email: string;
  created_at: string;
}

/*
 * An unambiguous alphabet: no l/1/I, no O/0. These get read off a screen and
 * typed into a phone, and the pair that gets mistyped is always the same pair.
 */
function genPassword(): string {
  const charset = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 12; i++) out += charset[arr[i] % charset.length];
  return out + "!";
}

export function MembersClient(props: { workspaces: Workspace[]; members: Member[] }) {
  return (
    <ToastHost>
      <MembersBody {...props} />
    </ToastHost>
  );
}

function MembersBody({ workspaces, members }: { workspaces: Workspace[]; members: Member[] }) {
  const router = useRouter();
  const show = useShowToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [allAccess, setAllAccess] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ user_id: string; email: string } | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  const membersByEmail = useMemo(() => {
    const map = new Map<
      string,
      { user_id: string | null; workspaces: string[]; role: string; created_at: string }
    >();
    for (const m of members) {
      const cur = map.get(m.email);
      const ws = workspaces.find((w) => w.id === m.workspace_id)?.name ?? m.workspace_id;
      if (cur) {
        cur.workspaces.push(ws);
        if (m.created_at < cur.created_at) cur.created_at = m.created_at;
      } else {
        map.set(m.email, {
          user_id: m.user_id,
          workspaces: [ws],
          role: m.role,
          created_at: m.created_at,
        });
      }
    }
    return Array.from(map.entries()).map(([email, v]) => ({ email, ...v }));
  }, [members, workspaces]);

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      show({ text: "Password must be at least 8 characters.", bad: true });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tools/master-inbox/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          full_name: fullName || undefined,
          role: "member",
          workspace_ids: allAccess ? "all" : Array.from(selected),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        show({ text: body.error ?? "Could not create user", bad: true });
        return;
      }
      show({
        text: `${email} ${body.already_existed ? "updated" : "created"} — share the password to let them sign in.`,
      });
      setEmail("");
      setFullName("");
      setPassword("");
      setSelected(new Set());
      router.refresh();
    } catch {
      show({ text: "Could not create user", bad: true });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      show({ text: "Password must be at least 8 characters.", bad: true });
      return;
    }
    setResetting(true);
    try {
      const res = await fetch("/api/tools/master-inbox/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: resetTarget.user_id, password: resetPassword }),
      });
      const body = await res.json();
      if (!res.ok) {
        show({ text: body.error ?? "Reset failed", bad: true });
        return;
      }
      show({ text: `Password reset for ${resetTarget.email}` });
      setResetTarget(null);
      setResetPassword("");
    } catch {
      show({ text: "Reset failed", bad: true });
    } finally {
      setResetting(false);
    }
  }

  const canInvite =
    !submitting && Boolean(email) && password.length >= 8 && (allAccess || selected.size > 0);

  return (
    <>
      <Section
        title="Add a teammate"
        sub="Set an initial password and share it over a secure channel. They can change it from their own personal settings once they are in."
      >
        <form onSubmit={submitInvite} className="mis-form">
          <div className="mis-g mis-g2">
            <Field label="Email" htmlFor="member-email">
              <input
                id="member-email"
                className="inp"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@brokerstaffer.com"
              />
            </Field>
            <Field label="Full name" optional="(optional)" htmlFor="member-name">
              <input
                id="member-name"
                className="inp"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
              />
            </Field>
          </div>

          <Field
            label="Initial password"
            htmlFor="member-password"
            hint="Plain text so you can copy and share it. Stored hashed in Supabase."
          >
            <div className="mis-inline">
              <input
                id="member-password"
                className="inp"
                type="text"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
              <Btn onClick={() => setPassword(genPassword())} data-mis="gen-password">
                Generate
              </Btn>
            </div>
          </Field>

          <div className="mis-f">
            <span className="mis-l">Workspace access</span>
            <label className="mis-check">
              <Checkbox
                checked={allAccess}
                aria-label="All workspaces"
                onCheckedChange={(v) => setAllAccess(Boolean(v))}
              />
              <span>All workspaces ({workspaces.length})</span>
            </label>
            {!allAccess ? (
              <div className="mis-picklist">
                {workspaces.map((w) => (
                  <label key={w.id} className="mis-check">
                    <Checkbox
                      checked={selected.has(w.id)}
                      aria-label={w.name}
                      onCheckedChange={(v) => {
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (v) next.add(w.id);
                          else next.delete(w.id);
                          return next;
                        });
                      }}
                    />
                    <span>{w.name}</span>
                    {w.emailbison_team_id ? (
                      <span className="mis-count tnum" style={{ marginLeft: "auto" }}>
                        EB #{w.emailbison_team_id}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <div>
            <button
              type="submit"
              className="btn btn-pri"
              disabled={!canInvite}
              data-mis="add-user"
              style={!canInvite ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
            >
              {submitting ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      </Section>

      <div className="tbl-wrap mis-sec">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Members ({membersByEmail.length})</div>
            <div className="tbl-sub">Workspaces are mirrored from EmailBison.</div>
          </div>
        </div>
        <div className="tbl-scroll">
          <table className="atbl">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Workspaces</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {membersByEmail.map((m) => (
                <tr key={m.email} data-mis-member={m.email}>
                  <td style={{ fontWeight: 600, color: "var(--ink)" }}>{m.email}</td>
                  <td>
                    <span className="plan plan-min mis-cap">{m.role}</span>
                  </td>
                  <td className="mut">
                    {m.workspaces.length === workspaces.length
                      ? `All (${workspaces.length})`
                      : m.workspaces.slice(0, 3).join(", ") +
                        (m.workspaces.length > 3 ? ` +${m.workspaces.length - 3}` : "")}
                  </td>
                  <td className="mis-cell-a">
                    <div>
                      {m.user_id ? (
                        <Btn
                          data-mis="reset-password"
                          style={{ padding: "6px 11px", fontSize: 12.5 }}
                          onClick={() => {
                            setResetTarget({ user_id: m.user_id as string, email: m.email });
                            setResetPassword(genPassword());
                          }}
                        >
                          <KeyRound
                            aria-hidden
                            style={{ width: 14, height: 14, marginRight: 6, verticalAlign: -2 }}
                          />
                          Reset password
                        </Btn>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {membersByEmail.length === 0 ? (
                <tr>
                  <td colSpan={4} className="mis-empty-cell">
                    No members yet — add one above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <form onSubmit={submitReset}>
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Set a new password for{" "}
                <b style={{ color: "var(--ink)" }}>{resetTarget?.email}</b>. Share it over a
                secure channel.
              </DialogDescription>
            </DialogHeader>
            <div className="mis-form" style={{ margin: "16px 0" }}>
              <Field label="New password" htmlFor="reset_pw">
                <div className="mis-inline">
                  <input
                    id="reset_pw"
                    className="inp"
                    type="text"
                    required
                    minLength={8}
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                  />
                  <Btn onClick={() => setResetPassword(genPassword())}>Generate</Btn>
                </div>
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={resetting || resetPassword.length < 8}>
                {resetting ? "Setting…" : "Set password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
