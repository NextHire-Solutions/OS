/** Roster shapes and constants — safe to import from client components and tests. */

export const ROLES = ["salesperson", "account_manager"] as const;
export type PersonRole = (typeof ROLES)[number];

export const ROLE_LABELS: Record<PersonRole, string> = {
  salesperson: "Salespeople",
  account_manager: "Account managers",
};

/** The singular noun, for the "New …'s name" placeholder and the confirm text. */
export const ROLE_NOUN: Record<PersonRole, string> = {
  salesperson: "salesperson",
  account_manager: "account manager",
};

export type Person = {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  role: PersonRole;
  photo_url: string | null;
};

export function isRole(value: unknown): value is PersonRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Initials fallback for anyone without a photo. */
export function initialsOf(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * ~200 KB of base64 — a 128px avatar is nearer 8 KB.
 *
 * Photos arrive as data URLs already resized by the browser; the cap is here so
 * a hand-edited request cannot push a multi-megabyte string into the row.
 */
export const MAX_PHOTO = 200_000;

export type PhotoCheck = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * The orchestrator's `checkPhoto`, with a discriminated result instead of its
 * `string | null | { error }` union.
 *
 * Same three rules, unchanged: nothing is fine, a data URL must be png/jpeg/webp
 * or else an https link, and it must be under the cap.
 */
export function validatePhoto(photo: string | null | undefined): PhotoCheck {
  if (!photo) return { ok: true, value: null };
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(photo) && !/^https?:\/\//.test(photo)) {
    return { ok: false, error: "photo must be an image file or an https link" };
  }
  if (photo.length > MAX_PHOTO) return { ok: false, error: "photo too large — pick a smaller image" };
  return { ok: true, value: photo };
}
