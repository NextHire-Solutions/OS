"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/identity/password";

/*
 * Account — the one screen that is about the signed-in person, not the
 * business. Today it holds a single thing: their password.
 *
 * Invited people (os_users) change it here. AUTH_USERS accounts are managed
 * in Railway, and the screen says exactly how rather than offering a form
 * that could not save.
 *
 * `?first=1` is where sign-in sends someone still on the temporary password
 * an admin handed them; `?next=` is where they were going.
 */

const FIELD: React.CSSProperties = { display: "grid", gap: 5 };
const LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };

interface Me { email: string; source: "env" | "db"; canChange: boolean; mustChangePassword: boolean }

export function AccountScreen({ email }: { email: string }) {
  const params = useSearchParams();
  const first = params?.get("first") === "1";
  const next = safeNext(params?.get("next") ?? "/");

  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [nextPw, setNextPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/password")
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`); return r.json() as Promise<Me>; })
      .then((m) => !cancelled && setMe(m))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load"));
    return () => { cancelled = true; };
  }, []);

  const mismatch = again.length > 0 && again !== nextPw;
  const valid = current.length > 0 && nextPw.length >= MIN_PASSWORD_LENGTH && again === nextPw;

  async function submit() {
    setBusy(true); setFailed("");
    try {
      const r = await fetch("/api/auth/password", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ current, next: nextPw }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.error ?? `HTTP ${r.status}`);
      setDone(true); setCurrent(""); setNextPw(""); setAgain("");
      setMe((m) => (m ? { ...m, mustChangePassword: false } : m));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.01em" }}>Account</h1>
        <p style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 4 }}>{me?.email ?? email}</p>
      </div>

      {first && me?.mustChangePassword && !done ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Welcome.</b> You signed in with a temporary password — set your own before you continue.
        </div>
      ) : null}

      {error ? <div className="card"><p style={{ fontSize: 14, color: "var(--red)" }}>{error}</p></div> : null}


      {me?.canChange ? (
        <div className="card">
          <div className="card-l">Change password</div>
          {done ? (
            <div style={{ display: "grid", gap: 12 }}>
              <p style={{ fontSize: 14, margin: 0 }}>Password changed. Other devices signed in as you have been signed out.</p>
              <a className="btn btn-pri" href={next} style={{ justifySelf: "start" }}>{first ? "Continue" : "Done"}</a>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 14, maxWidth: 420 }}>
              <label style={FIELD}>
                <span style={LABEL}>Current password</span>
                <input className="inp" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </label>
              <label style={FIELD}>
                <span style={LABEL}>New password</span>
                <input className="inp" type="password" autoComplete="new-password" value={nextPw} onChange={(e) => setNextPw(e.target.value)} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>At least {MIN_PASSWORD_LENGTH} characters. A short sentence works well.</span>
              </label>
              <label style={FIELD}>
                <span style={LABEL}>New password, again</span>
                <input className="inp" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)}
                  aria-invalid={mismatch || undefined} />
                {mismatch ? <span style={{ fontSize: 12, color: "var(--red)" }}>These do not match.</span> : null}
              </label>
              {failed ? <div style={{ fontSize: 13, color: "var(--red)" }}>{failed}</div> : null}
              <div>
                <button type="button" className="btn btn-pri" onClick={submit} disabled={!valid || busy}>
                  {busy ? "Changing…" : "Change password"}
                </button>
              </div>
              {me.source === "env" ? (
                <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>
                  Your account is listed in Railway&rsquo;s <code>AUTH_USERS</code>. A password set here is what signs you in from now on; the Railway entry is no longer consulted and needs no change.
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {!me && !error ? <p style={{ fontSize: 14, color: "var(--muted)" }}>Loading…</p> : null}
    </div>
  );
}

/* Same rule as the login form: only a same-origin path is followed. */
function safeNext(next: string): string {
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
