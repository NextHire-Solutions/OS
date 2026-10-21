"use client";

/*
 * The client sign-in forms (21 Oct): an email and "Send link to log in"; the
 * code from the email; the link's own "Sign in" button; sign out. They talk
 * only to /api/portal-signin, which never says whether an address may sign in.
 */

import { useState } from "react";

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/portal-signin/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, error: j.error };
  } catch {
    return { ok: false, error: "Couldn't reach BrokerStaffer. Check your connection and try again." };
  }
}

export function EmailForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return setError("Enter your work email address.");
    setBusy(true);
    setError(null);
    const r = await post("request", { email: a });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "That didn't work. Please try again.");
    window.location.assign(`/portal-signin/check?e=${encodeURIComponent(a)}`);
  };
  return (
    <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label htmlFor="psi-email">
        Work email
        <input id="psi-email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" />
      </label>
      {error ? <p className="psi-err" role="alert">{error}</p> : null}
      <button className="psi-btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send link to log in"}</button>
    </form>
  );
}

export function CodeForm({ email }: { email: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(c)) return setError("Enter the 6-digit code from the email.");
    setBusy(true);
    setError(null);
    const r = await post("code", { email, code: c });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "That didn't work. Please try again.");
    window.location.assign("/portal-signin/done");
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label htmlFor="psi-code">
        Or enter the code from the email
        <input id="psi-code" className="psi-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} placeholder="123 456" />
      </label>
      {error ? <p className="psi-err" role="alert">{error}</p> : null}
      <button className="psi-btn" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

export function ConfirmButton({ t }: { t: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await post("confirm", { t });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "That didn't work. Please try again.");
    window.location.assign("/portal-signin/done");
  };
  return (
    <>
      {error ? <p className="psi-err" role="alert">{error}</p> : null}
      <button className="psi-btn" type="button" onClick={() => void go()} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      {error ? <p className="psi-small"><a href="/portal-signin">Ask for a new sign-in link</a></p> : null}
    </>
  );
}

export function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button className="psi-link" type="button" disabled={busy} onClick={async () => { setBusy(true); await post("signout", {}); window.location.assign("/portal-signin"); }}>
      Sign out
    </button>
  );
}
