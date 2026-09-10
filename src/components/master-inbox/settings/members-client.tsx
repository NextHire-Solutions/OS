"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, KeyRound } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import { Label } from "@/components/mi-ui/label";
import { Checkbox } from "@/components/mi-ui/checkbox";
import { Badge } from "@/components/mi-ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";

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

function genPassword(): string {
  const charset = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 12; i++) out += charset[arr[i] % charset.length];
  return out + "!";
}

export function MembersClient({ workspaces, members }: { workspaces: Workspace[]; members: Member[] }) {
  const router = useRouter();
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
    const map = new Map<string, { user_id: string | null; workspaces: string[]; role: string; created_at: string }>();
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
      toast.error("Password must be at least 8 characters.");
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
        toast.error(body.error ?? "Could not create user");
        return;
      }
      toast.success(`${email} ${body.already_existed ? "updated" : "created"} — share the password to let them sign in.`);
      setEmail("");
      setFullName("");
      setPassword("");
      setSelected(new Set());
      router.refresh();
    } catch {
      toast.error("Could not create user");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
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
        toast.error(body.error ?? "Reset failed");
        return;
      }
      toast.success(`Password reset for ${resetTarget.email}`);
      setResetTarget(null);
      setResetPassword("");
    } catch {
      toast.error("Reset failed");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border bg-card p-6">
        <h2 className="text-base font-semibold">Add a teammate</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Set an initial password — share it with them via secure channel. They can change it from
          their personal settings after signing in.
        </p>
        <form onSubmit={submitInvite} className="mt-4 space-y-4 max-w-2xl">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@brokerstaffer.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="full_name">Full name (optional)</Label>
              <Input
                id="full_name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Initial password</Label>
            <div className="flex gap-2">
              <Input
                id="password"
                type="text"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
              <Button type="button" variant="outline" onClick={() => setPassword(genPassword())}>
                Generate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Plain text so you can copy and share. Stored hashed in Supabase.</p>
          </div>
          <div className="space-y-2">
            <Label>Workspace access</Label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={allAccess}
                onCheckedChange={(v) => setAllAccess(Boolean(v))}
              />
              <span>All workspaces ({workspaces.length})</span>
            </label>
            {!allAccess ? (
              <div className="border rounded-md p-3 max-h-64 overflow-y-auto space-y-1.5">
                {workspaces.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(w.id)}
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
                      <span className="text-xs text-muted-foreground ml-auto">EB #{w.emailbison_team_id}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <Button type="submit" disabled={submitting || !email || password.length < 8 || (!allAccess && selected.size === 0)}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : "Add user"}
          </Button>
        </form>
      </section>

      <section className="rounded-lg border bg-card">
        <div className="p-6 pb-4">
          <h2 className="text-base font-semibold">Members ({membersByEmail.length})</h2>
          <p className="text-sm text-muted-foreground mt-1">Workspaces are mirrored from EmailBison.</p>
        </div>
        <div className="border-t">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground uppercase tracking-wider">
              <tr>
                <th className="text-left font-medium px-6 py-2">Email</th>
                <th className="text-left font-medium px-6 py-2">Role</th>
                <th className="text-left font-medium px-6 py-2">Workspaces</th>
                <th className="text-right font-medium px-6 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {membersByEmail.map((m) => (
                <tr key={m.email} className="border-t">
                  <td className="px-6 py-3 font-medium">{m.email}</td>
                  <td className="px-6 py-3">
                    <Badge variant="outline">{m.role}</Badge>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {m.workspaces.length === workspaces.length
                      ? `All (${workspaces.length})`
                      : m.workspaces.slice(0, 3).join(", ") +
                        (m.workspaces.length > 3 ? ` +${m.workspaces.length - 3}` : "")}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {m.user_id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setResetTarget({ user_id: m.user_id as string, email: m.email });
                          setResetPassword(genPassword());
                        }}
                      >
                        <KeyRound className="size-3.5 mr-1.5" />
                        Reset password
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {membersByEmail.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-sm text-muted-foreground">
                    No members yet — add one above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <form onSubmit={submitReset}>
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Set a new password for <span className="font-medium text-foreground">{resetTarget?.email}</span>.
                Share it with them via a secure channel.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 my-4">
              <Label htmlFor="reset_pw">New password</Label>
              <div className="flex gap-2">
                <Input
                  id="reset_pw"
                  type="text"
                  required
                  minLength={8}
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                />
                <Button type="button" variant="outline" onClick={() => setResetPassword(genPassword())}>
                  Generate
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setResetTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={resetting || resetPassword.length < 8}>
                {resetting ? <Loader2 className="size-4 animate-spin" /> : "Set password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
