/*
 * Can a tool actually be embedded yet?
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT
 *
 * The whole single-sign-on design rests on one fact: every app sharing an apex
 * (`*.brokerstaffer.com`) makes an iframe SAME-SITE, so a `Domain=.brokerstaffer.com;
 * SameSite=Lax` cookie is first-party everywhere and survives third-party-cookie
 * deprecation.
 *
 * Today the apps live on `*.up.railway.app`. That looks like a shared apex and
 * is not: `up.railway.app` is on the Public Suffix List, so browsers treat every
 * subdomain as a separate site. A cookie cannot be set on `.up.railway.app` at
 * all, and none is sent into a cross-site iframe.
 *
 * So embedding a tool right now would render its login screen inside our shell.
 * That is worse than not embedding: it looks like the workspace is broken, when
 * in fact a DNS record is missing.
 *
 * Until the custom domains exist, a pane says so and offers the tool in a new
 * tab — which works perfectly. This function is what decides between the two,
 * and it will start returning `true` on its own the moment the hosts move,
 * with no code change.
 */

/** Hosts whose subdomains are separate sites, not a shared apex. */
const PUBLIC_SUFFIXES = [
  "up.railway.app",
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "fly.dev",
  "herokuapp.com",
  "github.io",
  "pages.dev",
  "workers.dev",
];

/**
 * The registrable domain — the part a cookie may be scoped to.
 *
 * Returns null when the host sits directly under a public suffix, because in
 * that case there is no shareable parent at all.
 */
export function registrableDomain(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!clean || clean === "localhost") return clean || null;

  for (const suffix of PUBLIC_SUFFIXES) {
    if (clean === suffix || clean.endsWith(`.${suffix}`)) {
      // e.g. os-production.up.railway.app → no shareable parent exists.
      return null;
    }
  }

  const parts = clean.split(".");
  if (parts.length < 2) return clean;
  return parts.slice(-2).join(".");
}

export type EmbedVerdict =
  | { embeddable: true }
  | { embeddable: false; reason: string; detail: string };

/**
 * Whether `toolUrl` can be embedded in a page served from `shellHost`.
 *
 * Deliberately conservative: it answers "will the session survive the iframe",
 * not "will the iframe load". A pane that loads and then shows a login is the
 * failure this exists to prevent.
 */
export function canEmbed(shellHost: string, toolUrl: string): EmbedVerdict {
  let toolHost: string;
  try {
    toolHost = new URL(toolUrl).host;
  } catch {
    return {
      embeddable: false,
      reason: "Not configured",
      detail: "This tool has no URL set.",
    };
  }

  const shell = registrableDomain(shellHost);
  const tool = registrableDomain(toolHost);

  // Same origin is trivially fine — useful for local development.
  if (shellHost.toLowerCase() === toolHost.toLowerCase()) return { embeddable: true };

  if (!shell || !tool) {
    return {
      embeddable: false,
      reason: "Needs a shared domain",
      detail:
        "The workspace and this tool are on railway.app subdomains, which browsers treat as separate sites — a shared sign-in cookie cannot reach across them. Point both at brokerstaffer.com subdomains and this pane starts working with no code change.",
    };
  }

  if (shell !== tool) {
    return {
      embeddable: false,
      reason: "Needs a shared domain",
      detail: `The workspace is on ${shell} and this tool on ${tool}. A sign-in cookie cannot span two domains, so an embedded pane would show the tool's own login.`,
    };
  }

  return { embeddable: true };
}
