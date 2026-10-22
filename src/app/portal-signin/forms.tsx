"use client";

/*
 * The client sign-in forms (21 Oct): an email and "Send link to log in"; the
 * code from the email; the link's own "Sign in" button; sign out. They talk
 * only to /api/portal-signin, which never says whether an address may sign in.
 */

import { useEffect, useRef, useState } from "react";

/*
 * The bot check (Cloudflare Turnstile, 22 Oct; lib/portal-login/turnstile.ts).
 * Drawn only when the server passes a site key; each submit spends its token,
 * so the widget is reset after every try. Usually it passes by itself without
 * a click; a person may be asked to tick a box.
 */
type TurnstileApi = { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id?: string): void; remove(id: string): void };
let loading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

function HumanCheck({ siteKey, action, onToken, resetKey }: { siteKey: string; action: string; onToken: (t: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const report = useRef(onToken);
  report.current = onToken;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    loadTurnstile()
      .then(() => {
        const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        if (gone || !box.current || !api) return;
        widget.current = api.render(box.current, {
          sitekey: siteKey,
          action,
          size: "flexible",
          callback: (t: string) => report.current(t),
          "expired-callback": () => report.current(null),
          "error-callback": () => report.current(null),
        });
      })
      .catch(() => { if (!gone) setFailed(true); });
    return () => {
      gone = true;
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (widget.current && api) api.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action]);
  useEffect(() => {
    const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (resetKey && widget.current && api) {
      report.current(null);
      api.reset(widget.current);
    }
  }, [resetKey]);
  return (
    <div>
      <div ref={box} data-human-check="" />
      {failed ? <p className="psi-err" role="alert">The security check couldn&apos;t load. Check your connection, then reload this page.</p> : null}
    </div>
  );
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/portal-signin/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, error: j.error };
  } catch {
    return { ok: false, error: "Couldn't reach BrokerStaffer. Check your connection and try again." };
  }
}

export function EmailForm({ siteKey = null }: { siteKey?: string | null }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return setError("Enter your work email address.");
    if (siteKey && !token) return setError("Please complete the security check below.");
    setBusy(true);
    setError(null);
    const r = await post("request", { email: a, ...(token ? { token } : {}) });
    setBusy(false);
    // A token works once: a fresh check for the next try.
    setResetKey((n) => n + 1);
    if (!r.ok) return setError(r.error ?? "That didn't work. Please try again.");
    window.location.assign(`/portal-signin/check?e=${encodeURIComponent(a)}`);
  };
  return (
    <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label htmlFor="psi-email">
        Work email
        <input id="psi-email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brokerage.com" />
      </label>
      {siteKey ? <HumanCheck siteKey={siteKey} action="signin-request" onToken={setToken} resetKey={resetKey} /> : null}
      {error ? <p className="psi-err" role="alert">{error}</p> : null}
      <button className="psi-btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send link to log in"}</button>
      {/*
        The email's code works here too (22 Oct audit): someone who closed the
        "Check your email" tab could only ask again — which cancels the code
        they hold. This goes to the code box without sending anything.
      */}
      <button
        className="psi-linkbtn"
        type="button"
        onClick={() => {
          const a = email.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return setError("Enter your work email address, then the code.");
          window.location.assign(`/portal-signin/check?e=${encodeURIComponent(a)}`);
        }}
      >
        I already have a code from the email
      </button>
    </form>
  );
}

export function CodeForm({ email, siteKey = null }: { email: string; siteKey?: string | null }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(c)) return setError("Enter the 6-digit code from the email.");
    if (siteKey && !token) return setError("Please complete the security check below.");
    setBusy(true);
    setError(null);
    const r = await post("code", { email, code: c, ...(token ? { token } : {}) });
    setBusy(false);
    setResetKey((n) => n + 1);
    if (!r.ok) return setError(r.error ?? "That didn't work. Please try again.");
    window.location.assign("/portal-signin/done");
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label htmlFor="psi-code">
        Or enter the code from the email
        <input id="psi-code" className="psi-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} placeholder="123 456" />
      </label>
      {siteKey ? <HumanCheck siteKey={siteKey} action="signin-code" onToken={setToken} resetKey={resetKey} /> : null}
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
