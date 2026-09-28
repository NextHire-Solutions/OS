import "server-only";

import { osTable } from "./os-db";
import { isKnownNonClient } from "./roster";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { deleteClientRow } from "@/lib/tools/client-health/clientWrites";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";

/*
 * Removing a client, and the limits on doing so.
 *
 * ---------------------------------------------------------------------------
 * THREE SCOPES, BECAUSE THEY ARE DIFFERENT ACTS
 *
 *   "os"         — drop it from the OS client list. Every tool keeps its own
 *                  row, every portal keeps working. Reversible: the client can
 *                  be adopted again from any tool.
 *
 *   "tools"      — the above, plus the Analytics, Client Health and Database
 *                  rows. Throws away campaign attribution and billing history.
 *
 *   "everything" — the above, plus the Master Inbox row AND ITS PORTAL. This is
 *                  the one that can destroy something a customer is using.
 *
 * ---------------------------------------------------------------------------
 * THE DATABASE LEG, AND WHY IT WAS MISSING
 *
 * Onboarding writes FOUR tools (onboard-plan.ts: analytics, client_health,
 * database, master_inbox). Deleting cleaned only three: the `orch_clients` row
 * was never touched, so every client deleted here stayed in the Database app
 * forever — in its Client filter dropdown, its Clients page and its export
 * picker. It also kept the client's `orchKey` occupied, so re-creating that
 * client later linked to the orphan instead of making a fresh row.
 *
 * Deleting an `orch_clients` row cascades ONE thing that matters:
 *
 *   orch_client_leads        ON DELETE CASCADE   the agents built for them
 *   instantly_replies        ON DELETE SET NULL  kept, unlinked
 *   bison_campaigns          ON DELETE SET NULL  kept, unlinked
 *
 * So the lead count is read first and shown, exactly as the portal's cascade
 * is. Any foreign key not listed above is necessarily RESTRICT — which fails
 * the delete loudly instead of destroying anything, and is reported per-leg.
 *
 * ---------------------------------------------------------------------------
 * WHY "everything" IS GATED ON WHAT IS ACTUALLY THERE
 *
 * Removing the Master Inbox row cascades (migration 0023):
 *
 *   client_pipeline_entries   ON DELETE CASCADE   the portal's whole pipeline
 *   client_agents             ON DELETE CASCADE   their agent roster
 *   client_dnc_entries        ON DELETE CASCADE   their do-not-contact list
 *   client_team_members       ON DELETE CASCADE   their team
 *   threads                   ON DELETE SET NULL  kept, but untagged
 *
 * For a client created moments ago every one of these is zero, and removing it
 * is a clean undo — which is exactly what testing the onboarding flow needs.
 * For a trading client it is everything their portal shows, plus a `portal_
 * token` that is random and unrecoverable, so the link in their hands 404s.
 *
 * Identical SQL, completely different act. So the counts are read FIRST, shown,
 * and a client with real portal data needs an explicit acknowledgement on top
 * of its name — typing carefully is not the same as knowing what is inside.
 */

export type DeleteScope = "os" | "tools" | "everything";

export interface CascadeCounts {
  pipelineEntries: number;
  agents: number;
  dncEntries: number;
  teamMembers: number;
  threads: number;
}

export interface DeletePlan {
  name: string;
  scope: DeleteScope;
  /** What will actually be removed, in order. */
  willDelete: string[];
  /** What is deliberately left alone. */
  willKeep: string[];
  /** Present when this must not proceed. */
  blocked: string | null;
  /** Shown before confirming — the consequence someone must actually read. */
  warnings: string[];
  /** Live counts of what the Master Inbox cascade would take. Null unless "everything". */
  cascade: CascadeCounts | null;
  /**
   * Leads that would go with the Database record (orch_client_leads cascades).
   * 0 at the "os" scope, which does not touch that row.
   */
  orchLeads: number;
  /**
   * True when a cascade would destroy real data, not just an empty shell —
   * from EITHER the portal's contents or the Database's leads.
   */
  destructive: boolean;
}

const CASCADE_TABLES = [
  ["client_pipeline_entries", "pipelineEntries"],
  ["client_agents", "agents"],
  ["client_dnc_entries", "dncEntries"],
  ["client_team_members", "teamMembers"],
] as const;

async function countCascade(miClientId: string): Promise<CascadeCounts> {
  const db = getMasterInboxSupabase();
  const counts: Record<string, number> = {};
  for (const [table, key] of CASCADE_TABLES) {
    const { count } = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("client_id", miClientId);
    counts[key] = count ?? 0;
  }
  const { count: threads } = await db
    .from("threads")
    .select("id", { count: "exact", head: true })
    .eq("client_id", miClientId);
  return {
    pipelineEntries: counts.pipelineEntries ?? 0,
    agents: counts.agents ?? 0,
    dncEntries: counts.dncEntries ?? 0,
    teamMembers: counts.teamMembers ?? 0,
    threads: threads ?? 0,
  };
}

interface Row {
  id: string;
  name: string;
  status: string;
  an_client_id: string | null;
  ch_client_id: string | null;
  mi_client_id: string | null;
  orch_client_id: string | null;
}

/**
 * Lead rows that would go with the Database record.
 *
 * `orch_client_leads.client_id` is ON DELETE CASCADE, so these are destroyed
 * with the row. Counted before anything is decided, for the same reason the
 * portal's cascade is: "removes its Database row" tells the reader nothing
 * about whether that row has 0 leads or 7,000 behind it.
 *
 * Failure returns null rather than 0 — "we could not read this" and "there is
 * nothing there" must not look the same when the answer gates a delete.
 */
async function countOrchLeads(orchClientId: string): Promise<number | null> {
  try {
    const { count, error } = await getOnboardingDb()
      .from("orch_client_leads")
      .select("id", { count: "exact", head: true })
      .eq("client_id", orchClientId);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

async function load(id: string): Promise<Row> {
  const { data, error } = await osTable("os_clients")
    .select("id, name, status, an_client_id, ch_client_id, mi_client_id, orch_client_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the client: ${error.message}`);
  if (!data) throw new Error("No such client");
  return data as unknown as Row;
}

/** What a delete would do. Computed before anything is removed, and shown. */
export async function planDelete(id: string, scope: DeleteScope): Promise<DeletePlan> {
  const row = await load(id);
  const willDelete: string[] = ["the OS client record and its onboarding history"];
  const willKeep: string[] = [];
  const warnings: string[] = [];
  let blocked: string | null = null;
  /*
   * Declared up here because BOTH cascades feed them: the Database's leads and
   * the portal's contents. `destructive` gates the extra acknowledgement, and it
   * must be true if EITHER would destroy real data — an empty portal does not
   * make deleting 7,000 leads a cleanup.
   */
  let destructive = false;
  let orchLeads = 0;

  /*
   * The demo portal backs a live demonstration client. Deleting it would break
   * something a person is showing to customers, and it is exactly the row
   * someone would mistake for clutter.
   */
  if (isKnownNonClient(row.name)) {
    blocked = `"${row.name}" is protected — it is not a billed client and something depends on it.`;
  }

  /*
   * "everything" must be a SUPERSET of "tools".
   *
   * It was not. The test read `scope === "tools"` and everything else fell into
   * the `else` written for "os", so the option labelled "Delete everywhere,
   * including the portal" removed the OS record, the Master Inbox row and the
   * portal — and left the Analytics and Client Health rows behind. The dialog
   * was at least honest about it ("Will keep: its Analytics row"), but the
   * label said the opposite of what it did.
   *
   * Worse, neither scope could finish the job: "tools" left the portal, and
   * both delete the OS record, so after either one the client is off the list
   * with its stored ids gone and no way to clean up the rest from the UI.
   */
  const dropsToolRows = scope === "tools" || scope === "everything";

  if (dropsToolRows) {
    if (row.an_client_id) {
      willDelete.push("its Analytics client row");
      warnings.push(
        "Analytics campaigns fall back to Unassigned — campaign data is kept, " +
          "but this client's attribution is lost until it is re-created and re-synced.",
      );
    }
    if (row.ch_client_id) {
      willDelete.push("its Client Health client row");
      warnings.push("Client Health loses this client's plan, billing anchor and campaign links.");
    }
    if (row.orch_client_id) {
      const leads = await countOrchLeads(row.orch_client_id);
      if (leads === null) {
        willDelete.push("its Database record");
        warnings.push(
          "Its Database lead count could not be read, so how much this destroys is unknown. " +
            "Leads cascade with that row — check the Database app before proceeding.",
        );
      } else if (leads > 0) {
        orchLeads = leads;
        destructive = true;
        willDelete.push(`its Database record — and the ${leads} leads built for it`);
        warnings.push(
          `Its Database record has ${leads} leads attached, which are deleted with it ` +
            "(orch_client_leads cascades). That is the agent research done for this client. " +
            "Mark it churned instead unless you are certain.",
        );
      } else {
        willDelete.push("its Database record");
        warnings.push(
          "Its Database record has no leads attached, so nothing researched is lost. " +
            "The client also leaves the Database app's Client filter and export picker.",
        );
      }
    }
  } else {
    if (row.an_client_id) willKeep.push("its Analytics row");
    if (row.ch_client_id) willKeep.push("its Client Health row");
    if (row.orch_client_id) willKeep.push("its Database record and any leads built for it");
  }

  /*
   * What the Master Inbox row HOLDS, counted live.
   *
   * These counts are the difference between a safe cleanup and a serious loss,
   * so they are read before anything is decided and shown before anything is
   * asked. Without them the dialog would say "removes its Master Inbox row" and
   * the reader would have no idea whether that row is an empty shell from five
   * minutes ago or a portal with 200 pipeline entries inside it.
   */
  let cascade: CascadeCounts | null = null;

  if (row.mi_client_id) {
    cascade = await countCascade(row.mi_client_id);
    // OR, never assign: the Database leg above may already have set this, and an
    // empty portal must not clear a pending loss of leads.
    destructive =
      destructive ||
      cascade.pipelineEntries > 0 ||
      cascade.agents > 0 ||
      cascade.dncEntries > 0 ||
      cascade.teamMembers > 0;

    const parts = [
      cascade.pipelineEntries ? `${cascade.pipelineEntries} pipeline entries` : null,
      cascade.agents ? `${cascade.agents} agents` : null,
      cascade.dncEntries ? `${cascade.dncEntries} do-not-contact entries` : null,
      cascade.teamMembers ? `${cascade.teamMembers} team members` : null,
    ].filter(Boolean);

    if (scope === "everything") {
      willDelete.push("its Master Inbox row — and with it the portal URL, permanently");
      willDelete.push("its Intro Macro reply template, if it has one");
      for (const p of parts) willDelete.push(`${p} inside its portal`);
      if (cascade.threads) {
        willKeep.push(`${cascade.threads} threads — kept, but they lose their client tag`);
      }
      warnings.push(
        "The portal token is random and cannot be recovered. Anyone holding that link gets a 404.",
      );
      warnings.push(
        destructive
          ? `Its portal holds ${parts.join(", ")}. Deleting is not a cleanup here — it is the ` +
            "loss of everything that portal shows. Mark it churned instead unless you are certain."
          : "Its portal is empty, so nothing inside it is lost.",
      );
    } else {
      willKeep.push("its Master Inbox row, its portal URL and its thread tags");
      warnings.push(
        parts.length
          ? `Its portal holds ${parts.join(", ")}. None of that is touched at this scope.`
          : "Its portal is empty — nothing is stored inside it.",
      );
    }
  }

  return {
    name: row.name, scope, willDelete, willKeep, blocked, warnings,
    cascade, orchLeads, destructive,
  };
}

export interface DeleteResult {
  name: string;
  scope: DeleteScope;
  removed: string[];
  failed: { what: string; error: string }[];
}

/**
 * Performs the delete.
 *
 * `confirm` must be the client's exact name. Not a checkbox: this is the one
 * irreversible action in the workspace, and a checkbox is one stray click.
 */
export async function deleteClient(
  id: string,
  { scope, confirm, acceptDataLoss = false }:
    { scope: DeleteScope; confirm: string; acceptDataLoss?: boolean },
): Promise<DeleteResult> {
  const row = await load(id);
  if (confirm.trim() !== row.name.trim()) {
    throw new Error("The confirmation text must repeat the client's name exactly.");
  }
  const plan = await planDelete(id, scope);
  if (plan.blocked) throw new Error(plan.blocked);
  /*
   * The second gate, and the one that does the real work.
   *
   * A client whose portal is empty can go on the strength of its name alone —
   * that is the test-client case, and it is the common one. A client with real
   * pipeline entries, agents or a DNC list cannot, however carefully the name
   * was typed, because typing a name carefully is not the same as knowing what
   * is inside the thing you are deleting.
   */
  /*
   * NOT gated on scope === "everything" any more.
   *
   * It used to be, which was right while only the portal could cascade. The
   * Database leg runs at "tools" as well, and `orch_client_leads` cascades with
   * that row — so a "tools" delete could destroy thousands of researched leads
   * while this gate looked the other way because no portal was involved.
   */
  if (plan.destructive && !acceptDataLoss) {
    const c = plan.cascade;
    const parts = [
      c?.pipelineEntries ? `${c.pipelineEntries} pipeline entries` : null,
      c?.agents ? `${c.agents} agents` : null,
      c?.dncEntries ? `${c.dncEntries} do-not-contact entries` : null,
      c?.teamMembers ? `${c.teamMembers} team members` : null,
      plan.orchLeads ? `${plan.orchLeads} Database leads` : null,
    ].filter(Boolean);
    throw new Error(
      `This would destroy ${parts.join(", ")}. Acknowledge that explicitly to proceed, ` +
        "or mark the client churned instead.",
    );
  }

  const removed: string[] = [];
  const failed: { what: string; error: string }[] = [];

  // Same superset rule as planDelete — the plan and the executor must agree,
  // or the dialog describes one thing and the button does another.
  if (scope === "tools" || scope === "everything") {
    if (row.an_client_id) {
      try {
        const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
        if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
        const token = await mintAnalyticsSession(
          secret,
          optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com",
        );
        const res = await fetch(`${baseUrlEnv("ANALYTICS_URL")}/api/clients/${row.an_client_id}`, {
          method: "DELETE",
          headers: { cookie: `bsa_session=${token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        removed.push("Analytics");
      } catch (e) {
        failed.push({ what: "Analytics", error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (row.ch_client_id) {
      try {
        /*
         * Straight into Client Health's database through clientWrites.ts —
         * the same `deleteClientRow` the Client Health screens use, with the
         * same cascade: the row, its weekly_metrics (the database's foreign
         * key), and campaign cache rows no other client still links to. This
         * used to DELETE through the live tool's /api/clients with a cookie
         * derived from the dashboard password; that app is being switched
         * off, and one write path is easier to keep honest than two.
         */
        const result = await deleteClientRow(getClientHealthDb(), row.ch_client_id);
        if (!result.ok) throw new Error(result.error);
        removed.push("Client Health");
      } catch (e) {
        failed.push({ what: "Client Health", error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (row.orch_client_id) {
      try {
        /*
         * The Database record. `orch_clients` is inside the guard's writable
         * `orch_*` prefix, so this delete is allowed; a typo'd table name would
         * throw before the network call rather than touching the 1.17M-row
         * `agents` table that shares this project.
         *
         * Runs after Analytics and Client Health and before Master Inbox, which
         * keeps the whole sequence cheapest-to-undo first. Re-creating this row
         * is one insert; re-creating a portal token is impossible.
         */
        const { error } = await getOnboardingDb()
          .from("orch_clients")
          .delete()
          .eq("id", row.orch_client_id);
        if (error) throw new Error(error.message);
        removed.push("Database");
      } catch (e) {
        failed.push({ what: "Database", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /*
   * The portal goes only if everything before it succeeded.
   *
   * This leg is the one that cannot be undone — the portal token is random, so
   * a deleted portal is a dead URL forever. The Analytics and Client Health
   * deletes now run ahead of it, and if either failed we stop here: the client
   * keeps its portal and stays on the list with its links intact, which is a
   * state someone can look at and retry. Destroying the irreversible thing
   * because a reversible thing already failed is the wrong way round.
   */
  if (scope === "everything" && row.mi_client_id && failed.length === 0) {
    try {
      const db = getMasterInboxSupabase();
      /*
       * Master Inbox's own DELETE needs a signed-in browser session, so the
       * workspace cannot call it. This is the one place we write to a Master
       * Inbox table directly, and it does exactly what that route does:
       * refuse the `unknown` fallback, then delete by id, letting the
       * ON DELETE CASCADE from migration 0023 take the portal's contents.
       *
       * One difference worth knowing: the route also clears two in-process
       * caches. We cannot reach those, so Master Inbox may keep offering the
       * client in its own pickers for up to 60 seconds afterwards.
       */
      const { data: existing } = await db
        .from("clients")
        .select("id, slug, name")
        .eq("id", row.mi_client_id)
        .maybeSingle();
      if (!existing) {
        removed.push("Master Inbox (already gone)");
      } else if (existing.slug === "unknown") {
        failed.push({ what: "Master Inbox", error: "the 'Unknown' fallback client cannot be deleted" });
      } else {
        const { error } = await db.from("clients").delete().eq("id", row.mi_client_id);
        if (error) throw new Error(error.message);
        removed.push("Master Inbox and its portal");
        /*
         * The client's "Intro Macro - <name>" reply template.
         *
         * Onboarding creates it, and nothing removed it: it has no foreign key
         * to the client, so the cascade above never reaches it. Every delete
         * left one behind in Master Inbox's template picker, offering to
         * introduce a client that no longer exists ("Brandolino Group" is one,
         * found 28 Sep).
         *
         * Matched on the EXACT name onboarding writes, taken from the row just
         * deleted — never a pattern, so a similarly named client's template
         * cannot be caught. Not fatal: the client is gone either way.
         */
        const templateName = `Intro Macro - ${existing.name as string}`;
        const { error: tErr } = await db.from("reply_templates").delete().eq("name", templateName);
        if (!tErr) removed.push("its Intro Macro template");
      }
    } catch (e) {
      failed.push({ what: "Master Inbox", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /*
   * The OS record goes LAST. If a tool delete failed, the client stays on the
   * list with its links intact, so the failure is visible and can be retried —
   * rather than vanishing from the OS while still existing elsewhere, which is
   * precisely the drift this whole feature exists to end.
   */
  if (failed.length === 0) {
    await osTable("os_client_onboarding").delete().eq("os_client_id", id);
    const { error } = await osTable("os_clients").delete().eq("id", id);
    if (error) failed.push({ what: "the OS client record", error: error.message });
    else removed.push("the OS client record");
  }

  return { name: row.name, scope, removed, failed };
}
