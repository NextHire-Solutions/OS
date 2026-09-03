/*
 * Turning a grid of toggles into the BS_GRANTS line you paste into Railway.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF A DATABASE
 *
 * Permissions are two tables' worth of data — a few dozen rows — and standing
 * up a database project to hold them is not worth the money or the extra thing
 * to run. So the Team access screen edits a local copy of the matrix and this
 * renders the exact environment value that would produce it.
 *
 * The cost is honest and visible: saving is a paste and a redeploy, not a
 * click. The screen says so rather than pretending otherwise, because a toggle
 * that looks saved and isn't is worse than a toggle that admits it.
 *
 * Everything above this file is written against `GrantStore`, so replacing
 * this with a real table later changes one adapter and nothing in any app.
 *
 * ---------------------------------------------------------------------------
 * THE WARNINGS ARE THE POINT
 *
 * A permissions editor that will happily lock you out of your own workspace is
 * a trap. The checks below run before anything is copied, because after the
 * redeploy is far too late.
 */

import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

export interface DesiredGrant {
  email: string;
  grants: ToolId[];
}

export type WarningLevel = "danger" | "caution";

export interface Warning {
  level: WarningLevel;
  message: string;
}

export interface GrantsConfig {
  /** The exact value to paste. Empty string means "grant nobody anything". */
  value: string;
  /** Rows whose grants differ from what is live now. */
  changed: { email: string; from: ToolId[]; to: ToolId[] }[];
  warnings: Warning[];
  /** True when the paste would change nothing. */
  unchanged: boolean;
}

/** Formats one line. Order follows ALL_TOOLS so the output is stable. */
function line(email: string, grants: ToolId[]): string {
  return `${email}:${ALL_TOOLS.filter((t) => grants.includes(t)).join(",")}`;
}

function sameSet(a: ToolId[], b: ToolId[]): boolean {
  const left = ALL_TOOLS.filter((t) => a.includes(t));
  const right = ALL_TOOLS.filter((t) => b.includes(t));
  return left.length === right.length && left.every((t, i) => t === right[i]);
}

/**
 * Builds the config line and everything the screen needs to explain it.
 *
 * `current` is what the live store reports, so "changed" means changed from
 * what is actually running — not from whatever the screen last rendered.
 */
export function buildGrantsConfig(
  desired: DesiredGrant[],
  current: DesiredGrant[],
  options: { editorEmail?: string; adminEmails?: string[] } = {},
): GrantsConfig {
  const currentByEmail = new Map(
    current.map((c) => [c.email.trim().toLowerCase(), c.grants]),
  );

  const rows = desired
    .map((d) => ({
      email: d.email.trim().toLowerCase(),
      // Unknown tool names are dropped here as well as at read time. A typo
      // must never widen access, at any point in the round trip.
      grants: ALL_TOOLS.filter((t) => d.grants.includes(t)),
    }))
    .filter((d) => d.email)
    .sort((a, b) => a.email.localeCompare(b.email));

  const changed = rows
    .filter((r) => !sameSet(r.grants, currentByEmail.get(r.email) ?? []))
    .map((r) => ({
      email: r.email,
      from: currentByEmail.get(r.email) ?? [],
      to: r.grants,
    }));

  const warnings: Warning[] = [];

  // --- the lock-yourself-out checks ---------------------------------------
  const editor = options.editorEmail?.trim().toLowerCase();
  if (editor) {
    const mine = rows.find((r) => r.email === editor);
    const before = currentByEmail.get(editor) ?? [];
    const lost = before.filter((t) => !(mine?.grants ?? []).includes(t));
    if (lost.length > 0) {
      warnings.push({
        level: "caution",
        message: `This removes your own access to ${lost.join(", ")}. You will still be able to sign in and edit this screen.`,
      });
    }
  }

  // A tool nobody can open is almost always a mistake rather than an intent.
  for (const tool of ALL_TOOLS) {
    const holders = rows.filter((r) => r.grants.includes(tool));
    if (holders.length === 0) {
      warnings.push({
        level: "danger",
        message: `Nobody would have access to ${tool}. Every direct link to it will be refused.`,
      });
    }
  }

  // Somebody listed in AUTH_USERS but absent from the paste gets nothing —
  // silently, because absence is how BS_GRANTS says "no access".
  for (const c of current) {
    const email = c.email.trim().toLowerCase();
    if (!rows.some((r) => r.email === email) && c.grants.length > 0) {
      warnings.push({
        level: "danger",
        message: `${email} is missing from this list and would lose all access.`,
      });
    }
  }

  // Everyone with nothing is a valid state, and also a very easy misclick.
  if (rows.length > 0 && rows.every((r) => r.grants.length === 0)) {
    warnings.push({
      level: "danger",
      message: "No one would have access to any tool.",
    });
  }

  // Setting BS_GRANTS for the first time ends the bootstrap fail-open, which
  // is a bigger change than the diff suggests: anyone not listed drops from
  // "everything" to "nothing".
  const bootstrapping = current.every((c) => c.grants.length === ALL_TOOLS.length);
  if (bootstrapping && rows.some((r) => r.grants.length < ALL_TOOLS.length)) {
    warnings.push({
      level: "caution",
      message:
        "BS_GRANTS is not set yet, so everyone currently has every tool. Setting it makes this list authoritative — anyone missing from it gets no access.",
    });
  }

  return {
    value: rows.map((r) => line(r.email, r.grants)).join("\n"),
    changed,
    warnings,
    unchanged: changed.length === 0,
  };
}
