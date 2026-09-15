import "server-only";

import { getOnboardingDb } from "./db";
import { isFieldType, validateField, type ClientField, type FieldType } from "./client-field-types";

export * from "./client-field-types";

/**
 * Custom fields on a client profile.
 *
 * Ported from the orchestrator's `lib/client-fields.ts` and
 * `app/field-actions.ts`. Free-form extras the team invents themselves — a
 * website, a contract link, a second phone. Nothing in the automation reads
 * them: no email template, no lead filter, no connector. That is what makes them
 * safe to add and delete at will, unlike the built-in fields above them on the
 * profile.
 *
 * Every write below is scoped by `id` or `client_id`. `orch_client_fields` has
 * no unique constraint that would save an unfiltered update, so the scope is the
 * only thing standing between an edit and every custom field on every client.
 */

const MAX_VALUE = 2000;

type Result = { ok: boolean; error?: string; id?: string };

export async function getClientFields(clientId: string): Promise<ClientField[]> {
  const { data, error } = await getOnboardingDb()
    .from("orch_client_fields")
    .select("id, label, type, value, sort")
    .eq("client_id", clientId)
    .order("sort")
    .order("created_at");
  if (error) return [];
  return (data ?? []) as ClientField[];
}

/**
 * Labels already in use anywhere, so adding "Website" to a second client is a
 * pick, not a retype — the closest thing to a shared field definition without
 * forcing every client to carry every field.
 */
export async function getKnownFieldLabels(): Promise<string[]> {
  const { data } = await getOnboardingDb().from("orch_client_fields").select("label").limit(1000);
  return [...new Set((data ?? []).map((r) => r.label as string))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export async function addClientField(
  clientId: string,
  label: string,
  type: string,
  value: string,
): Promise<Result> {
  const clean = label.trim();
  if (!clean) return { ok: false, error: "give the field a name" };
  if (!isFieldType(type)) return { ok: false, error: "unknown field type" };
  if (value.length > MAX_VALUE) return { ok: false, error: "value is too long" };

  const bad = validateField(type, value);
  if (bad) return { ok: false, error: bad };

  const db = getOnboardingDb();
  const { data: last } = await db
    .from("orch_client_fields")
    .select("sort")
    .eq("client_id", clientId)
    .order("sort", { ascending: false })
    .limit(1);

  const { data, error } = await db
    .from("orch_client_fields")
    .insert({
      client_id: clientId,
      label: clean,
      type,
      value: value.trim() || null,
      sort: ((last?.[0]?.sort as number | undefined) ?? 0) + 10,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id as string };
}

/**
 * Edit one field.
 *
 * `clientId` is not decoration: the tool scoped this update by `id` alone, which
 * is correct but means a field id from one client could be patched while looking
 * at another. Both are in the filter here, so a mismatched pair changes nothing
 * rather than the wrong row.
 */
export async function updateClientField(
  clientId: string,
  id: string,
  patch: { label?: string; type?: string; value?: string },
): Promise<Result> {
  const clean: Record<string, unknown> = {};

  if (patch.label !== undefined) {
    if (!patch.label.trim()) return { ok: false, error: "field name cannot be empty" };
    clean.label = patch.label.trim();
  }
  if (patch.type !== undefined) {
    if (!isFieldType(patch.type)) return { ok: false, error: "unknown field type" };
    clean.type = patch.type;
  }
  if (patch.value !== undefined) {
    if (patch.value.length > MAX_VALUE) return { ok: false, error: "value is too long" };
    // Validate against whichever type the field will have once this save lands.
    const type = (clean.type as FieldType | undefined) ?? (await currentType(clientId, id));
    if (type) {
      const bad = validateField(type, patch.value);
      if (bad) return { ok: false, error: bad };
    }
    clean.value = patch.value.trim() || null;
  }
  if (!Object.keys(clean).length) return { ok: true };
  clean.updated_at = new Date().toISOString();

  const { error } = await getOnboardingDb()
    .from("orch_client_fields")
    .update(clean)
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function currentType(clientId: string, id: string): Promise<FieldType | null> {
  const { data } = await getOnboardingDb()
    .from("orch_client_fields")
    .select("type")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  const t = data?.type as string | undefined;
  return t && isFieldType(t) ? t : null;
}

export async function deleteClientField(clientId: string, id: string): Promise<Result> {
  const { error } = await getOnboardingDb()
    .from("orch_client_fields")
    .delete()
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Reorder by swapping sort values with the neighbour in that direction. */
export async function moveClientField(
  clientId: string,
  id: string,
  dir: "up" | "down",
): Promise<Result> {
  const db = getOnboardingDb();
  const { data: fields } = await db
    .from("orch_client_fields")
    .select("id, sort")
    .eq("client_id", clientId)
    .order("sort")
    .order("created_at");
  if (!fields) return { ok: true };

  const rows = fields as { id: string; sort: number }[];
  const i = rows.findIndex((f) => f.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  // Pressing ↑ on the top row is a no-op, not an error — the tool's behaviour.
  if (i < 0 || j < 0 || j >= rows.length) return { ok: true };

  const [a, b] = await Promise.all([
    db.from("orch_client_fields").update({ sort: rows[j].sort }).eq("id", rows[i].id).eq("client_id", clientId),
    db.from("orch_client_fields").update({ sort: rows[i].sort }).eq("id", rows[j].id).eq("client_id", clientId),
  ]);
  const error = a.error ?? b.error;
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
