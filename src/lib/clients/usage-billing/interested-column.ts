import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { clientHasFeature } from "@/lib/tools/master-inbox/portals/feature-flags";
import { INTERESTED_STAGE_KEY, interestedStageRows, MANAGE_STAGES_FLAG, type ClientStageRow } from "@/lib/tools/master-inbox/portals/stage-config";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { portalsOf } from "./leads.ts";

/*
 * A client on pay per lead has an Interested column on its Pipeline (4 Nov, the user: "when we turn on pay per lead system for
 * any client then it should have interested column there"). On pay per lead = it has settings here, test or live.
 *
 * Made when the settings are saved, and looked at again by the hourly run: every portal of the client, so a market added later
 * gets it too, and one taken off or hidden from the old portal (which can't refuse that) comes back. A portal that has the
 * column showing is left exactly as it is, renamed or moved. A client's other portals, and clients not on pay per lead, are
 * never touched.
 */

type Row = Record<string, unknown>;

/** The Interested column on each of this client's portals. How many portals changed. Throws at the end, once every portal has had its turn. */
export async function ensureInterestedColumn(osClientId: string): Promise<number> {
  const mi = getMasterInboxSupabase();
  let changed = 0;
  const problems: string[] = [];
  for (const portalId of await portalsOf(osClientId)) {
    try {
      const { data: client, error } = await mi.from("clients").select("feature_flags, stage_label_overrides").eq("id", portalId).maybeSingle();
      if (error) throw new Error(`clients: ${error.message}`);
      if (!client) continue;
      const stageClient = client as { feature_flags?: Row | null; stage_label_overrides?: Row | null };
      // Every portal has this on (63 of 63, 4 Nov). Without it neither portal reads the rows, so the column could not show.
      if (!clientHasFeature(stageClient, MANAGE_STAGES_FLAG)) throw new Error(`portal ${portalId} has ${MANAGE_STAGES_FLAG} off`);
      const { data: rows, error: rowsErr } = await mi.from("client_pipeline_stages").select("key, label, color, sort_order, kind, canonical_stage, hidden").eq("client_id", portalId);
      if (rowsErr) throw new Error(`client_pipeline_stages: ${rowsErr.message}`);
      const have = (rows ?? []) as ClientStageRow[];
      if (have.find((r) => r.key === INTERESTED_STAGE_KEY)?.hidden) {
        const { error: showErr } = await mi.from("client_pipeline_stages").update({ hidden: false, updated_at: new Date().toISOString() }).eq("client_id", portalId).eq("key", INTERESTED_STAGE_KEY);
        if (showErr) throw new Error(`client_pipeline_stages: ${showErr.message}`);
        console.log(`[usage-billing] Interested column shown again on portal ${portalId}`);
        changed += 1;
        continue;
      }
      const missing = interestedStageRows(stageClient, have);
      if (!missing.length) continue;
      // One statement: a portal never ends up with the new column and without its other stages.
      const { error: writeErr } = await mi.from("client_pipeline_stages").upsert(missing.map((r) => ({ client_id: portalId, ...r })), { onConflict: "client_id,key", ignoreDuplicates: true });
      if (writeErr) throw new Error(`client_pipeline_stages: ${writeErr.message}`);
      console.log(`[usage-billing] Interested column added on portal ${portalId}`);
      changed += 1;
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return changed;
}

/** For the hourly run: every client on pay per lead. One client's failure never stops the rest; what went wrong, by client. */
export async function ensureInterestedColumns(): Promise<Array<{ osClientId: string | null; message: string }>> {
  const { data, error } = await osTable("os_usage_billing_settings").select("os_client_id");
  if (error) return [{ osClientId: null, message: error.message }];
  const problems: Array<{ osClientId: string | null; message: string }> = [];
  for (const { os_client_id: id } of (data ?? []) as Array<{ os_client_id: string }>) {
    await ensureInterestedColumn(id).catch((e) => problems.push({ osClientId: id, message: e instanceof Error ? e.message : String(e) }));
  }
  return problems;
}
