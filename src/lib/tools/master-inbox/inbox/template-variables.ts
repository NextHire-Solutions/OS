// Variable definitions for reply templates.
//
// Templates support `{{lead.name}}`, `{{lead.email}}`, … placeholders
// that get substituted at insert-time using the current thread's lead
// + the logged-in user as the substitution context. The palette in the
// template editor and the picker in the composer both render from this
// shared list so they stay in sync.

export interface TemplateVariable {
  key: string; // The token, e.g. "lead.name"
  label: string; // Human-readable label
  description: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { key: "lead.name", label: "Lead name", description: "Full name of the recipient" },
  { key: "lead.first_name", label: "Lead first name", description: "Just the first name (best for personalisation)" },
  { key: "lead.email", label: "Lead email", description: "Recipient's email address" },
  { key: "lead.phone_number", label: "Lead phone number", description: "Recipient's phone (when known)" },
  { key: "lead.company", label: "Lead company", description: "Brokerage / firm the lead works at" },
  { key: "lead.title", label: "Lead title", description: "Role at their company (when known)" },
  { key: "thread.subject", label: "Thread subject", description: "The current conversation's subject line" },
  { key: "sender.name", label: "Your name", description: "Your full name as set in your profile" },
  { key: "sender.email", label: "Your email", description: "Your account email" },
  { key: "sender.first_name", label: "Your first name", description: "Just your first name" },
];

export interface SubstitutionContext {
  lead?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    company?: string | null;
    title?: string | null;
  };
  thread?: {
    subject?: string | null;
  };
  sender?: {
    name?: string | null;
    email?: string | null;
  };
}

// Extract a first name from a free-form "name" field. Handles two common
// shapes:
//   "Nicole Collins"             → "Nicole"        (first whitespace token)
//   "nicole.c@gohubrealty.com"   → "Nicole"        (local part, first
//                                                   chunk before . _ -,
//                                                   title-cased)
// The email path matters because most Instantly channels store
// display_name = the mailbox email itself, so without this fallback
// `{{sender.first_name}}` resolved to the entire address.
function firstName(full?: string | null): string {
  if (!full) return "";
  const trimmed = full.trim();
  if (!trimmed) return "";
  // Email-shaped → derive from local part
  if (/^\S+@\S+\.\S+$/.test(trimmed)) {
    const local = trimmed.split("@")[0] ?? "";
    const first = local.split(/[._-]/).find((p) => p.length > 0) ?? local;
    return capitaliseFirst(first);
  }
  // Free-form name → first whitespace token
  const token = trimmed.split(/\s+/)[0] ?? "";
  return capitaliseFirst(token);
}

// "Nicole Collins" → "Nicole Collins" (unchanged)
// "nicole.c@gohubrealty.com" → "Nicole C" (title-cased local-part parts)
// Email path matches the firstName() heuristic so both variables stay
// consistent — sender.name and sender.first_name come from the same root.
function readableName(full?: string | null): string | null {
  if (!full) return null;
  const trimmed = full.trim();
  if (!trimmed) return null;
  if (/^\S+@\S+\.\S+$/.test(trimmed)) {
    const local = trimmed.split("@")[0] ?? "";
    const parts = local
      .split(/[._-]/)
      .filter((p) => p.length > 0)
      .map(capitaliseFirst);
    return parts.length > 0 ? parts.join(" ") : trimmed;
  }
  return trimmed;
}

function capitaliseFirst(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Replace every {{key}} occurrence with the matching value from the
// context. Known keys with no value resolve to empty string so the
// composed message reads naturally (no literal `{{lead.name}}` left in
// the body when a lead has no name on file). Only UNKNOWN keys — i.e.
// a typo in the template like {{lead.namee}} — are left in place so
// the user spots the mistake.
const KNOWN_KEYS = new Set([
  "lead.name",
  "lead.first_name",
  "lead.email",
  "lead.phone_number",
  "lead.company",
  "lead.title",
  "thread.subject",
  "sender.name",
  "sender.first_name",
  "sender.email",
]);

export function substituteVariables(
  text: string,
  context: SubstitutionContext,
): string {
  const get = (key: string): string | null => {
    switch (key) {
      case "lead.name":
        return readableName(context.lead?.name);
      case "lead.first_name":
        return firstName(context.lead?.name);
      case "lead.email":
        return context.lead?.email ?? null;
      case "lead.phone_number":
        return context.lead?.phone ?? null;
      case "lead.company":
        return context.lead?.company ?? null;
      case "lead.title":
        return context.lead?.title ?? null;
      case "thread.subject":
        return context.thread?.subject ?? null;
      case "sender.name":
        return readableName(context.sender?.name);
      case "sender.first_name":
        return firstName(context.sender?.name);
      case "sender.email":
        return context.sender?.email ?? null;
      default:
        return null;
    }
  };
  return text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (match, key: string) => {
    const lower = key.toLowerCase();
    if (!KNOWN_KEYS.has(lower)) return match; // unknown key — leave for user to spot
    const v = get(lower);
    return v !== null && v.length > 0 ? v : "";
  });
}
