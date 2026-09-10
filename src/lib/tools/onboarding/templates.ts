import "server-only";

import { getOnboardingDb } from "./db";
import { isSystemTemplate, type Template } from "./template-types";

export * from "./template-types";

/**
 * The email, campaign-copy and intro-macro templates.
 *
 * Ported from the orchestrator's `lib/templates.ts` plus the three template
 * server actions in `app/actions.ts`. Edits take effect on the next send the
 * live orchestrator makes — this is the same table it reads at send time, not a
 * copy.
 */

export interface TemplateList {
  templates: Template[];
  error: string | null;
}

export async function listTemplates(category?: string): Promise<Template[]> {
  let q = getOnboardingDb()
    .from("orch_templates")
    .select("*")
    .order("category")
    .order("sort")
    .order("name");
  if (category) q = q.eq("category", category);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Template[];
}

/** The screen's loader: never throws, so a database fault renders as a message. */
export async function getTemplates(): Promise<TemplateList> {
  try {
    return { templates: await listTemplates(), error: null };
  } catch (error) {
    return {
      templates: [],
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}

export async function getTemplateByKey(key: string): Promise<Template | null> {
  const { data, error } = await getOnboardingDb()
    .from("orch_templates")
    .select("*")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as Template | null;
}

export async function createTemplate(category: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  if (!category.trim()) return { ok: false, error: "category required" };
  const { data, error } = await getOnboardingDb()
    .from("orch_templates")
    .insert({ category, name: "New template", body: "Hi {{firstName}},\n\n", sort: 999 })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id as string };
}

export async function saveTemplate(
  id: string,
  patch: { name?: string; subject?: string; body?: string; active?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "name cannot be empty" };
    clean.name = patch.name.trim();
  }
  if (patch.subject !== undefined) clean.subject = patch.subject;
  if (patch.body !== undefined) clean.body = patch.body;
  if (patch.active !== undefined) clean.active = patch.active;
  if (!Object.keys(clean).length) return { ok: true };

  const { error } = await getOnboardingDb()
    .from("orch_templates")
    .update({ ...clean, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Deleting is refused for the nine templates the automation sends by key.
 *
 * Not a UI nicety: the send looks the template up by key at the moment it needs
 * it, so a deleted one fails a client's welcome email with nothing on screen to
 * explain it.
 */
export async function deleteTemplate(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = getOnboardingDb();
  const { data: t } = await db.from("orch_templates").select("key").eq("id", id).maybeSingle();
  if (isSystemTemplate(t?.key as string | null | undefined)) {
    return {
      ok: false,
      error: "This template is sent by the automation — edit its wording instead of deleting it.",
    };
  }
  const { error } = await db.from("orch_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
