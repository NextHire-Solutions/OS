import "server-only";

import { getCorofySupabase } from "../corofy/supabase";
import { resolve } from "@/lib/clients/roster";

/*
 * Onboarding — the pipeline, read from the orchestrator's own tables.
 *
 * The live orchestrator keeps running exactly as it does: it receives Typeform,
 * EmailBison, Stripe and Calendly webhooks, holds the hub tokens, and writes
 * these rows. The workspace reads them. Nothing here takes over delivery, and
 * nothing here writes.
 *
 * What the screen has to answer, in order of how often it is asked:
 *
 *   who is stuck, and at which stage
 *   who has paid but not launched, and who has launched without paying
 *   how far through onboarding everybody is
 *
 * The last is the easy one and the least useful, which is why the counts here
 * lead with the exceptions rather than the totals.
 */

export interface Stage {
  id: string;
  name: string;
  sort: number;
  color: string | null;
}

export interface OnboardingClient {
  id: string;
  name: string;
  brand: string | null;
  officeName: string | null;
  primaryContact: string | null;
  status: string | null;
  stageId: string | null;
  stageName: string | null;
  plan: string | null;
  weeklyTarget: number | null;
  mls: string | null;
  location: string | null;
  /** True once Stripe reports payment. */
  paid: boolean;
  paidAt: string | null;
  amount: number | null;
  campaignStatus: string | null;
  leadsExported: number | null;
  leadsInReview: number | null;
  copyStatus: string | null;
  portalUrl: string | null;
  onboardingDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  healthStatus: string | null;
  /** The canonical roster name, when this client is on the roster. */
  rosterName: string | null;
  /** Introductions the orchestrator has recorded for this client. */
  intros: number;
  lastIntroAt: string | null;
}

export interface OnboardingPipeline {
  stages: Stage[];
  /**
   * The server's clock at load.
   *
   * The screen renders "waiting 14d", which is a function of now. Reading the
   * browser's clock instead would be a different instant from the server's,
   * and the same class of hydration bug that has already shipped twice here.
   */
  now: string;
  clients: OnboardingClient[];
  error: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/*
 * Rows as plain records.
 *
 * Without generated database types, supabase-js widens `.data` to a union that
 * includes a per-column error shape, so every field access fails to compile.
 * These tables belong to another app and its migrations are not ours to track,
 * so the accessors above validate each value at runtime instead — which is the
 * honest position: the shape is a fact about a database we do not own.
 */
type Row = Record<string, unknown>;
const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);

export async function getOnboardingPipeline(): Promise<OnboardingPipeline> {
  try {
    const sb = getCorofySupabase();

    /*
     * Introductions are counted here rather than joined, because the count is
     * the only thing the screen needs from a table with hundreds of rows per
     * client. Three small reads beat one wide join.
     */
    const [stagesRes, clientsRes, introsRes] = await Promise.all([
      sb.from("orch_stages").select("id,name,sort,color").order("sort"),
      sb
        .from("orch_clients")
        .select(
          "id,client_name,brand,office_name,primary_contact,status,stage_id,plan," +
            "weekly_target,mls,location,stripe_paid,stripe_paid_at,stripe_amount," +
            "bison_campaign_status,bison_leads_exported,leads_inreview,copy_status," +
            "portal_url,onboarding_date,created_at,updated_at,health_status",
        )
        .order("created_at", { ascending: false }),
      sb.from("orch_introductions").select("client_id,created_at"),
    ]);

    if (stagesRes.error) throw new Error(stagesRes.error.message);
    if (clientsRes.error) throw new Error(clientsRes.error.message);

    const stages: Stage[] = rows(stagesRes.data).map((s) => ({
      id: String(s.id),
      name: String(s.name),
      sort: Number(s.sort ?? 0),
      color: str(s.color),
    }));
    const stageName = new Map(stages.map((s) => [s.id, s.name]));

    // An introduction whose client row is gone is dropped rather than counted
    // against nobody — a total that no row explains is worse than a smaller one.
    const introCount = new Map<string, { n: number; last: string | null }>();
    for (const row of rows(introsRes.data)) {
      const id = str(row.client_id);
      if (!id) continue;
      const at = str(row.created_at);
      const cur = introCount.get(id) ?? { n: 0, last: null };
      cur.n += 1;
      if (at && (!cur.last || at > cur.last)) cur.last = at;
      introCount.set(id, cur);
    }

    const clients: OnboardingClient[] = rows(clientsRes.data).map((c) => {
      const id = String(c.id);
      const name = str(c.client_name) ?? str(c.brand) ?? str(c.office_name) ?? "Unnamed";
      const counts = introCount.get(id);
      return {
        id,
        name,
        brand: str(c.brand),
        officeName: str(c.office_name),
        primaryContact: str(c.primary_contact),
        status: str(c.status),
        stageId: str(c.stage_id),
        stageName: c.stage_id ? (stageName.get(String(c.stage_id)) ?? null) : null,
        plan: str(c.plan),
        weeklyTarget: num(c.weekly_target),
        mls: str(c.mls),
        location: str(c.location),
        paid: c.stripe_paid === true,
        paidAt: str(c.stripe_paid_at),
        amount: num(c.stripe_amount),
        campaignStatus: str(c.bison_campaign_status),
        leadsExported: num(c.bison_leads_exported),
        leadsInReview: num(c.leads_inreview),
        copyStatus: str(c.copy_status),
        portalUrl: str(c.portal_url),
        onboardingDate: str(c.onboarding_date),
        createdAt: str(c.created_at),
        updatedAt: str(c.updated_at),
        healthStatus: str(c.health_status),
        // Matched against the canonical roster so this screen counts clients
        // the same way every other screen in the workspace does.
        rosterName: resolve(name)?.name ?? null,
        intros: counts?.n ?? 0,
        lastIntroAt: counts?.last ?? null,
      };
    });

    return { stages, clients, now: new Date().toISOString(), error: null };
  } catch (error) {
    // A failure costs this screen, never the workspace.
    return {
      stages: [],
      clients: [],
      now: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}
