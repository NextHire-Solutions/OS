/**
 * Template shapes and the merge-field renderer — no server imports, so client
 * components and `node --test` can both use them.
 *
 * The rendering half is ported verbatim from the orchestrator's `lib/templates.ts`.
 * It is the part with actual behaviour worth testing: everything else in that
 * file is a Supabase call.
 */

export type Template = {
  id: string;
  category: string;
  key: string | null;
  name: string;
  subject: string | null;
  body: string;
  sort: number;
  active: boolean;
  updated_at: string;
};

/**
 * The categories the tool groups templates under, with the headings and hints
 * from its own Templates page.
 */
export const TEMPLATE_SECTIONS = [
  { cat: "email", label: "Automated emails", hint: "Welcome, intros, portal, campaign, etc." },
  {
    cat: "campaign_copy",
    label: "Campaign copy",
    hint: "Zillow Preferred sequences + custom — client approves before launch",
  },
  { cat: "intro_macro", label: "Intro macro", hint: "Warm-introduction macro template (Masterinbox)" },
] as const;

/**
 * Templates the automation sends by key. Deleting one would break a send at the
 * moment it is needed, with nothing in the UI to explain why — so the tool
 * refuses, and says to edit the wording instead.
 */
export const SYSTEM_TEMPLATE_KEYS = [
  "welcome",
  "welcome_nobooking",
  "confirmations",
  "how_intros_work",
  "meet_team",
  "portal",
  "dnc_reminder",
  "campaign_launched",
  "followup_call",
];

export function isSystemTemplate(key: string | null | undefined): boolean {
  return !!key && SYSTEM_TEMPLATE_KEYS.includes(key);
}

// Merge-field replacement that tolerates the docs' inconsistent casing/spacing:
// {{First Name}}, {{firstName}}, {{FirstName}} all resolve to the same value.
const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

export function render(text: string, vars: Record<string, unknown>): string {
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) map[norm(k)] = v == null ? "" : String(v);
  // Unknown tokens are left as-is so the team can see unfilled placeholders.
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, tok) => (norm(tok) in map ? map[norm(tok)] : m));
}

export function renderTemplate(t: Template, vars: Record<string, unknown>) {
  return { subject: render(t.subject ?? "", vars), body: render(t.body, vars) };
}

/** Plain template body -> simple HTML email. */
export function htmlBody(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111">${esc}</div>`;
}

/** Every merge field a body/subject mentions, in first-seen order. */
export function mergeFieldsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const tok = m[1].trim();
    const k = norm(tok);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(tok);
    }
  }
  return out;
}
