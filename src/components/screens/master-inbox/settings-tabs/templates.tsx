/*
 * Settings › templates — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/templates/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { TemplatesManager } from "@/components/master-inbox/settings/templates-manager";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";


export async function SettingsTemplates() {
  const session = await requireSession();
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("reply_templates")
    .select(
      "id, name, body, body_html, subject, cc, bcc, category, sort_order",
    )
    .eq("workspace_id", session.activeWorkspace.id)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  const initial = (data ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    body: (t.body as string) ?? "",
    body_html: (t.body_html as string | null) ?? null,
    subject: (t.subject as string | null) ?? null,
    cc: (t.cc as string | null) ?? null,
    bcc: (t.bcc as string | null) ?? null,
    category: (t.category as string | null) ?? null,
  }));

  return (
    <SettingsPageShell
      title="Templates"
      description="Saved reply snippets you can drop into the composer instead of retyping. Use variables like {{lead.first_name}} for instant personalisation."
    >
      <TemplatesManager initial={initial} />
    </SettingsPageShell>
  );
}
