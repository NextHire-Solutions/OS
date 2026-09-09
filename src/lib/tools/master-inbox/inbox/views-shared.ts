// Pure helpers shared by server + client code. No next/headers, no supabase.

export interface CustomView {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  filter_json: Record<string, unknown>;
  sort_order: number;
  is_system: boolean;
}

// Kebab-case the view name so we get human-readable URLs like
// /inbox/needs-reply or /inbox/follow-up-1 without exposing UUIDs.
export function slugifyView(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
