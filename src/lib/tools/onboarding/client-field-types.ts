/**
 * Custom-field shapes, validation and display rules.
 *
 * Ported from the orchestrator's `lib/client-field-types.ts`. No server imports,
 * so the editor component can validate as you type without pulling Supabase into
 * the browser bundle — the same split the tool made, for the same reason.
 */

export const FIELD_TYPES = ["text", "url", "email", "phone", "number", "date"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  url: "Link",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
};

export type ClientField = {
  id: string;
  label: string;
  type: FieldType;
  value: string | null;
  sort: number;
};

/** Narrowing guard, so a string off the wire can become a FieldType. */
export function isFieldType(type: string): type is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Loose on purpose. A wrong-looking value is the team's business — this only
 * catches the obvious typo, and an empty value is always allowed so a field can
 * be added before it is known.
 */
export function validateField(type: FieldType, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (type) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "that doesn't look like an email address";
    case "url":
      return /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/.test(v) ? null : "that doesn't look like a link";
    case "phone":
      return /^[+()\d][\d\s\-().]{5,}$/.test(v) ? null : "that doesn't look like a phone number";
    case "number":
      return /^-?\d+(\.\d+)?$/.test(v) ? null : "numbers only";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "use YYYY-MM-DD";
    default:
      return null;
  }
}

/** Make links, emails and phones clickable; everything else is plain text. */
export function formatFieldHref(type: FieldType, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (type === "url") return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  if (type === "email") return `mailto:${v}`;
  if (type === "phone") return `tel:${v.replace(/[^\d+]/g, "")}`;
  return null;
}

/** The client's MLS column holds one or more codes, comma-separated. */
export function mlsCodes(mls?: string | null): string[] {
  return (mls ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}
