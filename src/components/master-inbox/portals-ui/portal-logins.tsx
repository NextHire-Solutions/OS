"use client";

/*
 * Portal logins (21 Oct): the fixed list of addresses that may sign in to this
 * client's new portal — "a fixed email address that is allowed to login". Kept
 * by the people with the Client Portals switch. Adding an address sends
 * nothing; the person signs in at /portal-signin when the portal launches.
 * Removing one ends its access at once.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ModalDialog } from "@/components/ui/modal-dialog";

type Login = { id: string; email: string; name: string | null; added_by: string; added_at: string; last_sign_in_at: string | null };

const API = "/api/tools/master-inbox/portals/logins";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : null);

export function PortalLogins({ portalId, portalName }: { portalId: string; portalName: string }) {
  const [open, setOpen] = useState(false);
  const [logins, setLogins] = useState<Login[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`${API}?portal=${encodeURIComponent(portalId)}`);
    const j = (await res.json().catch(() => ({}))) as { logins?: Login[]; error?: string };
    if (!res.ok) { setError(j.error ?? "Couldn't load the list."); setLogins([]); return; }
    setLogins(j.logins ?? []);
  }, [portalId]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portal: portalId, email: email.trim(), name: name.trim() || null }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) return toast.error(j.error ?? "Couldn't add that address");
    toast.success(`${email.trim()} can sign in to ${portalName}`);
    setEmail(""); setName("");
    void load();
  };
  const remove = async (l: Login) => {
    if (!window.confirm(`Remove ${l.email}? They can no longer sign in to ${portalName}.`)) return;
    const res = await fetch(API, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portal: portalId, id: l.id }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return toast.error(j.error ?? "Couldn't remove that address");
    toast.success(`${l.email} removed`);
    void load();
  };

  return (
    <>
      <button type="button" className="open-live" onClick={() => setOpen(true)} data-portal-logins>
        Portal logins
        <KeyRound />
      </button>
      <ModalDialog open={open} onClose={() => setOpen(false)} width={560} label={`Portal logins — ${portalName}`}>
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 650 }}>Portal logins — {portalName}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.6 }}>
              Only these addresses can sign in to {portalName}&apos;s new portal, with a link emailed to them. Nobody else can — whatever address they type. Adding someone sends nothing.
            </div>
          </div>
          <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr auto", gap: 8 }}>
            <input className="inp" style={{ minWidth: 0 }} type="email" aria-label="Email address" placeholder="name@brokerage.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="inp" style={{ minWidth: 0 }} type="text" aria-label="Name (optional)" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn-pri" disabled={busy || !email.trim()}>{busy ? "Adding…" : "Add"}</button>
          </form>
          {error ? <div className="anno" style={{ background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }}>{error}</div> : null}
          {logins === null ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>
          ) : logins.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>No one can sign in yet.</div>
          ) : (
            <table className="tbl" style={{ width: "100%" }}>
              <thead><tr><th style={{ textAlign: "left" }}>Address</th><th style={{ textAlign: "left" }}>Last sign-in</th><th /></tr></thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{l.email}</div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>{[l.name, `added by ${l.added_by}`, day(l.added_at)].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td style={{ fontSize: 13, color: "var(--muted)" }}>{day(l.last_sign_in_at) ?? "Never"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="ib ib-danger" aria-label={`Remove ${l.email}`} title={`Remove ${l.email}`} onClick={() => void remove(l)}><Trash2 /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </ModalDialog>
    </>
  );
}
