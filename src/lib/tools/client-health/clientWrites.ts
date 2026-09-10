import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { BillingInterval, Plan } from "./types.ts";

/*
 * Creating, editing and deleting a client — straight into Client Health's
 * database.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A PROXY ANY MORE
 *
 * These three writes used to be forwarded to the live Client Health app's own
 * `/api/clients`. That worked, and it was the right shape while the OS was a
 * window onto a running product. It is the wrong shape now: Client Health is
 * being switched off, and a proxy dies with the thing it proxies to. On the day
 * that app stops answering, every edit, pause, churn and delete in the OS would
 * start failing — silently for the reader, who would only see "Save failed".
 *
 * So the logic moved rather than the traffic. What follows is the tool's route
 * reproduced against the same tables. It diverges from it in five places, each
 * one deliberate and each one listed in CLIENT-HEALTH-PARITY.md; the only one
 * that changes what is stored is `time_zone` on create, which the tool drops.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DELETE ACTUALLY REMOVES
 *
 * Three things, and only the first is obvious:
 *
 *   1. the `clients` row;
 *   2. every `weekly_metrics` row for that client — the DATABASE does this,
 *      not this code. `weekly_metrics.client_id` is
 *      `references clients(id) on delete cascade` (migration 0001), so the
 *      client's whole history goes the instant the row does. Roughly 26 to 40
 *      rows per client here, and nothing reports them;
 *   3. `instantly_campaigns` / `bison_campaigns` cache rows for campaigns that
 *      NO OTHER client still links to — this code does that, below, after the
 *      client is gone so the departing client no longer counts as a referrer.
 *
 * Nothing else. The database has five tables; `sync_runs` has no client link,
 * and the campaign tables have no foreign key to `clients` at all — the link is
 * the `text[]` column on the client, which is why step 3 has to be written by
 * hand rather than declared.
 *
 * Step 3 is a cache eviction, not a deletion of anything authoritative: the
 * next sync re-adds the campaign if it still exists upstream. It exists so that
 * re-adding a client of the same name does not immediately show months-old
 * campaign figures.
 *
 * ---------------------------------------------------------------------------
 * SCOPING
 *
 * Every `.update()` and `.delete()` below carries an `.eq()`. PostgREST applies
 * an unfiltered one to every row in the table, with no confirmation and nothing
 * to roll back. `src/lib/guards/blast-radius.test.ts` fails the build if one
 * ever loses its filter.
 */

export type WriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

/** The row shape callers get back. Loose on purpose — it is echoed, not read. */
export type ClientRow = Record<string, unknown>;

/*
 * The two enumerations the database enforces with CHECK constraints
 * (migrations 0001 and 0010). Declared here so a bad value is a 400 with a
 * readable message instead of a Postgres constraint-violation string, and
 * `satisfies` so they cannot drift from the types the screens use.
 */
const PLANS = ["minimum", "production", "partner"] as const satisfies readonly Plan[];
const BILLING_INTERVALS = [
  "biweekly",
  "28-days",
  "monthly",
  "custom",
] as const satisfies readonly BillingInterval[];

/**
 * A nullable text column where blank means "unset", not "the empty value".
 *
 * DIVERGENCE from the live tool, and the reason this exists: the modal's date
 * fields and its "no time zone" option all submit `""`. Stored literally, an
 * empty `time_zone` renders as a blank cell instead of the em dash that means
 * "not set", and an empty date is rejected by Postgres outright.
 */
const blankToNull = z
  .string()
  .nullable()
  .transform((v) => (v && v.trim() ? v.trim() : null));

const campaignIds = z.array(z.string());

/*
 * `clients.id` is a `uuid` column. Postgres accepts any 8-4-4-4-12 hex string
 * there — it does not check the version or variant nibbles the way a strict
 * RFC validator does — so this checks the shape only. A stricter test would
 * reject ids the database itself considers valid, which is the wrong kind of
 * safe: the point is to stop `?id=all` reaching a delete, not to audit how a
 * row's key was generated.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clientId = z.string().regex(UUID, "A valid client id is required");

export const createSchema = z.object({
  name: z.string().trim().min(1, "A client name is required").max(200),
  plan: z.enum(PLANS),
  weekly_target: z.number().int().min(0),
  monthly_target: z.number().int().min(0).optional(),
  start_date: blankToNull.optional(),
  instantly_campaign_ids: campaignIds.optional(),
  bison_campaign_ids: campaignIds.optional(),
  campaign_size: z.number().int().min(0).optional(),
  billing_anchor_date: blankToNull.optional(),
  billing_interval: z.enum(BILLING_INTERVALS).optional(),
  billing_interval_days: z.number().int().positive().nullable().optional(),
  time_zone: blankToNull.optional(),
});

/**
 * The row a create writes.
 *
 * Every default is the live route's own default, so a client created here is
 * indistinguishable from one created there — with ONE deliberate exception.
 *
 * DIVERGENCE — `time_zone`. The live tool's POST never reads it, even though
 * its own Add Client modal sends it, so every client added through that UI
 * arrives with no time zone and somebody has to go back and set it by hand.
 * Its PATCH does handle the field, which is what makes it clearly an omission
 * rather than a decision. Reproducing a bug for the sake of parity would mean
 * shipping a form whose field does nothing.
 */
export function insertValues(input: z.infer<typeof createSchema>): Record<string, unknown> {
  return {
    name: input.name,
    plan: input.plan,
    weekly_target: input.weekly_target,
    start_date: input.start_date ?? null,
    instantly_campaign_ids: input.instantly_campaign_ids ?? [],
    bison_campaign_ids: input.bison_campaign_ids ?? [],
    campaign_size: input.campaign_size ?? 0,
    billing_anchor_date: input.billing_anchor_date ?? null,
    billing_interval: input.billing_interval ?? "biweekly",
    billing_interval_days: input.billing_interval_days ?? null,
    monthly_target: input.monthly_target ?? 0,
    time_zone: input.time_zone ?? null,
  };
}

export const updateSchema = z.object({
  id: clientId,
  name: z.string().trim().min(1, "A client name cannot be empty").max(200).optional(),
  plan: z.enum(PLANS).optional(),
  weekly_target: z.number().int().min(0).optional(),
  start_date: blankToNull.optional(),
  instantly_campaign_ids: campaignIds.optional(),
  bison_campaign_ids: campaignIds.optional(),
  hidden: z.boolean().optional(),
  client_paused: z.boolean().optional(),
  portal_active: z.boolean().optional(),
  billing_anchor_date: blankToNull.optional(),
  billing_interval: z.enum(BILLING_INTERVALS).optional(),
  billing_interval_days: z.number().int().positive().nullable().optional(),
  time_zone: blankToNull.optional(),
  monthly_target: z.number().int().min(0).optional(),
});

/**
 * The columns an edit may touch, and no others.
 *
 * This is an allow-list, which is the part worth keeping from the live route.
 * Most of `clients` is written by the sync worker — `emails_today`,
 * `portal_url`, `intros_this_month`, the Corofy totals — and a PATCH that
 * spread the body into the update would let a stale browser tab overwrite
 * numbers the sync owns. Absent keys are left alone, so `{ id, client_paused }`
 * changes exactly one column.
 */
export function updateValues(input: z.infer<typeof updateSchema>): Record<string, unknown> {
  const { id: _id, ...rest } = input;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** A PostgREST error, turned into something worth putting on screen. */
interface PgError {
  message?: string;
  code?: string;
  details?: string;
}

function failed(error: PgError, status = 400): { ok: false; status: number; error: string } {
  // PGRST116 is "asked for one row, got none" — an id that is not there. A 404
  // says that; the tool's blanket 400 leaves the reader guessing.
  if (error.code === "PGRST116") {
    return { ok: false, status: 404, error: "No client with that id" };
  }
  return { ok: false, status, error: error.message ?? "The write was rejected" };
}

function invalid(error: z.ZodError): { ok: false; status: number; error: string } {
  const first = error.issues[0];
  const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
  return { ok: false, status: 400, error: `${where}${first?.message ?? "Invalid input"}` };
}

export async function createClientRow(db: SupabaseClient, body: unknown): Promise<WriteResult<ClientRow>> {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const { data, error } = await db
    .from("clients")
    .insert(insertValues(parsed.data))
    .select()
    .single();

  if (error) return failed(error);
  return { ok: true, value: data as ClientRow };
}

export async function updateClientRow(db: SupabaseClient, body: unknown): Promise<WriteResult<ClientRow>> {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const values = updateValues(parsed.data);
  // An id and nothing else. PostgREST would reject the empty body with a
  // parser error about the JSON; saying what is actually wrong is cheaper than
  // explaining that later.
  if (Object.keys(values).length === 0) {
    return { ok: false, status: 400, error: "No fields to update" };
  }

  const { data, error } = await db
    .from("clients")
    .update(values)
    .eq("id", parsed.data.id)
    .select()
    .single();

  if (error) return failed(error);
  return { ok: true, value: data as ClientRow };
}

/**
 * Is any client other than the one just deleted still linked to this campaign?
 *
 * `null` means the question could not be answered, and the caller leaves the
 * campaign alone. Deleting a cache row on a failed lookup would be the one
 * outcome worse than keeping an orphan.
 */
async function stillLinked(
  db: SupabaseClient,
  column: "instantly_campaign_ids" | "bison_campaign_ids",
  campaignId: string,
): Promise<boolean | null> {
  const { data, error } = await db
    .from("clients")
    .select("id")
    .contains(column, [campaignId])
    .limit(1);
  if (error) return null;
  return (data?.length ?? 0) > 0;
}

export async function deleteClientRow(
  db: SupabaseClient,
  id: string,
): Promise<WriteResult<{ orphansRemoved: number }>> {
  if (!UUID.test(id)) {
    return { ok: false, status: 400, error: "A valid client id is required" };
  }

  // 1. Read the links first. After step 2 the row is gone and with it any way
  //    of knowing which campaign cache rows were this client's.
  const { data: client, error: readError } = await db
    .from("clients")
    .select("instantly_campaign_ids, bison_campaign_ids")
    .eq("id", id)
    .single();
  if (readError) return failed(readError);

  const linkedInstantly: string[] = client?.instantly_campaign_ids ?? [];
  const linkedBison: string[] = client?.bison_campaign_ids ?? [];

  // 2. Delete the client. `weekly_metrics` follows automatically — the foreign
  //    key is ON DELETE CASCADE, so the client's entire metric history goes
  //    here without appearing in this file.
  const { error: deleteError } = await db.from("clients").delete().eq("id", id);
  if (deleteError) return failed(deleteError);

  // 3. Evict campaign cache rows nobody references any more. Deliberately
  //    after step 2: the check asks whether ANOTHER client links to the
  //    campaign, and the departing client must no longer be one of them.
  let orphansRemoved = 0;

  for (const campaignId of linkedInstantly) {
    if ((await stillLinked(db, "instantly_campaign_ids", campaignId)) !== false) continue;
    const { error } = await db.from("instantly_campaigns").delete().eq("id", campaignId);
    if (!error) orphansRemoved++;
  }

  for (const campaignId of linkedBison) {
    if ((await stillLinked(db, "bison_campaign_ids", campaignId)) !== false) continue;
    const { error } = await db.from("bison_campaigns").delete().eq("id", campaignId);
    if (!error) orphansRemoved++;
  }

  return { ok: true, value: { orphansRemoved } };
}
