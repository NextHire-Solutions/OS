import "server-only";

import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { findOrchCollision, isMatchableOrchName, type OrchRow } from "./orch-name";

/*
 * Creating the Database record — §2's "Create the Database record" and the
 * missing half of §21 step 3.
 *
 * The Database record is ONE ROW: orch_clients(client_name, status='new'). That
 * is the whole thing. A row there makes the client appear in the Database app's
 * Client filter, its Clients page and both of its pickers immediately; nothing
 * else needs creating. Three things that look like they matter do not:
 * `client_mls` is empty and unread, the 2-row `clients` table is one shared
 * Bison credential stored twice, and `db_client_id` is populated on 0 of 46
 * rows and referenced nowhere.
 *
 * ---------------------------------------------------------------------------
 * WHY IT READS BEFORE IT WRITES
 *
 * That row is matched to campaigns every six hours, and `makeCampaignMatcher`
 * refuses to guess on a tie: two rows reducing to the same normalised name make
 * it return null for BOTH, so their leads stop being attributed. Inserting a
 * colliding row therefore does not create a harmless duplicate — it breaks the
 * client that was already there.
 *
 * So a collision LINKS rather than fails. The goal is "this client has a
 * Database record", and an existing row is that record. That also makes the leg
 * idempotent, which matters because the onboarding runner can be resumed.
 *
 * Writes through getOnboardingDb(), whose guard allows writes to orch_* tables
 * and throws on anything else before the network call — so a mistyped table
 * name here cannot touch the 1.18M scraped agent rows in the same database.
 */

export interface DatabaseRecordResponse {
  status: number;
  body: unknown;
}

export async function createDatabaseRecord(name: string): Promise<DatabaseRecordResponse> {
  const clientName = (name ?? "").trim();
  if (!clientName) return { status: 400, body: { error: "client name is required" } };

  const db = getOnboardingDb();

  /*
   * The whole table, because the collision rule is not expressible as a WHERE
   * clause that stays in step with the matcher — which is exactly the mistake
   * the Database app's own create path made, normalising in SQL without
   * dropping "copy of" or a leading "the". 46 rows; reading them all is free.
   */
  const { data, error } = await db.from("orch_clients").select("id, client_name").limit(1000);
  if (error) {
    return { status: 502, body: { error: `could not read orch_clients: ${error.message}` } };
  }
  const rows = (data ?? []) as OrchRow[];

  const existing = findOrchCollision(clientName, rows);
  if (existing) {
    return {
      status: 200,
      body: {
        client: { id: existing.id, client_name: existing.client_name },
        existing: true,
        note:
          `Linked to the existing Database record "${existing.client_name}" instead of inserting ` +
          "beside it: two rows with the same normalised name make the campaign matcher abandon both.",
      },
    };
  }

  const { data: inserted, error: insertError } = await db
    .from("orch_clients")
    .insert({ client_name: clientName, status: "new" })
    .select("id, client_name")
    .single();
  if (insertError) {
    return { status: 502, body: { error: `could not create the Database record: ${insertError.message}` } };
  }

  return {
    status: 201,
    body: {
      client: inserted,
      existing: false,
      /*
       * Reported rather than refused. A name the matcher can never match is a
       * real dead end, but it is the client's actual name and blocking creation
       * over it would be worse than saying so.
       */
      ...(isMatchableOrchName(clientName)
        ? {}
        : {
            warning:
              `"${clientName}" reduces to fewer than 3 characters, which the campaign matcher ` +
              "skips — this client will never be attributed a campaign automatically.",
          }),
    },
  };
}
