"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/*
 * Where to land after a successful sign-in.
 *
 * `?next=` comes straight from the URL, so it is attacker-controlled. A bare
 * `startsWith("/")` check is NOT enough: the browser reads `//evil.com` as a
 * protocol-relative URL and would happily navigate off-site, which turns the
 * login page into an open redirect — a phishing primitive worth closing even
 * on an internal tool. Backslashes are rejected too, since some browsers
 * normalise `/\evil.com` the same way.
 */
function safeNext(next: string): string {
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const configError = params.get("error") === "config";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Sign in failed.");
        return;
      }

      // Full navigation, not router.push: the session cookie was just set and
      // the proxy needs to see it on a fresh request.
      window.location.href = safeNext(next);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setPending(false);
    }
  }

  // The design's own input, full width. `.inp` carries the border, radius,
  // focus ring and type scale, so nothing is redefined here.
  const inputStyle = { width: "100%", marginTop: 7 } as const;
  const labelStyle = {
    fontSize: 12.5,
    fontWeight: 500,
    color: "var(--ink-2)",
    display: "block",
  } as const;

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      {configError ? (
        <p
          style={{
            background: "var(--red-bg)",
            color: "var(--red)",
            borderRadius: "var(--r-sm)",
            padding: "10px 12px",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          Sign-in is not configured on this deployment.
        </p>
      ) : null}

      <div>
        <label htmlFor="email" style={labelStyle}>
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@brokerstaffer.com"
          className="inp"
          style={inputStyle}
        />
      </div>

      <div>
        <label htmlFor="password" style={labelStyle}>
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="inp"
          style={inputStyle}
        />
      </div>

      {error ? (
        <p role="alert" style={{ fontSize: 12.5, color: "var(--red)", lineHeight: 1.5 }}>
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="btn btn-pri"
        style={{ width: "100%", marginTop: 4, opacity: pending ? 0.6 : 1 }}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
