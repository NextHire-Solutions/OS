// Workspace-wide auto-CC for every outbound reply.
//
// Operator wants oversight: Nicole gets a copy of every reply the
// staff sends so the loop is automatic, not remembered. Two places
// read this constant — the composer (UI prefill + visible Cc row)
// and the reply route (final server-side enforcement). Sharing the
// constant guarantees they can never drift.
//
// Hardcoded for now. If/when the next ask is "make this per-
// workspace configurable", swap this module for a server-loaded
// value (workspaces.always_cc text column) — call sites read the
// same exported names so the migration stays local.

export const ALWAYS_CC_EMAIL = "nicole.c@brokerstaffer.com";

// Merge ALWAYS_CC_EMAIL into a "a@b.com, c@d.com" style CC string.
// Dedupes case-insensitively, preserves caller order, drops the
// auto-CC if it's already in the `to` field (operator is replying
// to a thread where Nicole IS the lead — she should only appear
// once, in `to`).
export function mergeAlwaysCcString(
  existingCc: string,
  toEmail?: string | null,
): string {
  const norm = (s: string) => s.toLowerCase().trim();
  const seen = new Set<string>();
  const inTo = toEmail ? new Set([norm(toEmail)]) : new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    const k = norm(v);
    if (inTo.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const part of existingCc.split(/[,;]/)) push(part);
  push(ALWAYS_CC_EMAIL);
  return out.join(", ");
}
