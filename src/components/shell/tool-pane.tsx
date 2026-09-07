"use client";

import { canEmbed } from "@/lib/workspace/embedding";

/*
 * One tool, on stage.
 *
 * Kept mounted once visited and merely hidden when you switch away, so coming
 * back is instant with scroll position and any unsent draft intact. `hidden`
 * rather than `display:none` via a class, because the attribute is what screen
 * readers and find-in-page respect.
 *
 * When the tool cannot be embedded yet, this renders an explanation instead of
 * an iframe. See lib/workspace/embedding.ts: the apps are on railway.app
 * subdomains, which browsers treat as separate sites, so a framed tool would
 * show its own login inside our shell — indistinguishable from a broken
 * workspace. A new tab works perfectly today, so that is what we offer.
 */

export function ToolPane({
  active,
  label,
  productLabel,
  baseUrl,
  path,
  verified,
  shellHost,
}: {
  active: boolean;
  label: string;
  productLabel: string;
  baseUrl: string;
  path: string;
  verified: boolean;
  shellHost: string;
}) {
  const href = baseUrl ? `${baseUrl.replace(/\/$/, "")}${path}` : "";
  const verdict = canEmbed(shellHost, href);

  if (verdict.embeddable) {
    return (
      <section className={`screen${active ? " on" : ""} pane-host`} hidden={!active}>
        <iframe
          src={`${href}${path.includes("?") ? "&" : "?"}embed=1`}
          title={`${productLabel} — ${label}`}
          className="tool-frame"
          // Same-origin is required for the shared cookie; without it the tool
          // would be signed out. allow-forms/popups/downloads keep the tool
          // fully usable inside the pane.
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals"
          loading="lazy"
        />
      </section>
    );
  }

  return (
    <section className={`screen${active ? " on" : ""}`} hidden={!active}>
      <div className="wrap" style={{ maxWidth: 720 }}>
        <div className="card" style={{ padding: "28px 30px" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: ".13em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            {verdict.reason}
          </div>

          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.02em", margin: "10px 0 8px" }}>
            {productLabel} · {label}
          </h1>

          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--muted)", marginBottom: 8 }}>
            {verdict.detail}
          </p>

          {!verified ? (
            <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--muted)", marginBottom: 8 }}>
              This link opens the tool&rsquo;s default view — {label} does not have its
              own address yet.
            </p>
          ) : null}

          <a
            href={href || undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-pri"
            style={{ display: "inline-block", marginTop: 14, textDecoration: "none" }}
          >
            Open {productLabel} in a new tab
          </a>
        </div>
      </div>
    </section>
  );
}
