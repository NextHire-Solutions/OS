/*
 * The pure half of this module lives in `stages-shared.ts` so client
 * components can import the stage vocabulary without pulling `server-only`
 * into a client bundle. Re-exported here so server-side import sites read
 * exactly as they do in the tool.
 */
export * from "./stages-shared";

// `export *` re-exports for callers but does not bind the names inside this
// module, and the loaders below annotate their types with them.
import type { PipelineEntry, PipelineNote, PipelineStage, TeamMember } from "./stages-shared";
import {
  resolveStageLabels,
  safeStageLabelsFor,
  visibleStagesFor,
  DEFAULT_STAGE_LABELS,
  STAGE_DESCRIPTIONS,
  STAGE_LABEL_MAX_LEN,
  STAGE_ORDER,
} from "./stages-shared";

import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

// Per-client data loaders for the portal expansion. Every query goes
// through the service-role admin client with a code-level client_id
// filter — same pattern as lib/portals/intro-leads.ts.

// Hosts whose URLs must never reach a client-facing portal — internal
// agent-sourcing tools (e.g. Courted) we don't expose to clients. Matched
// as a hostname substring so every subdomain (brokerage.courted.io) and any
// query string is covered. Applied at LOAD TIME only: the row in the DB, the
// inbox prospect panel, and the Follow Up Boss push all keep the raw value —
// this strips it purely from the portal payload the client sees.
const CONCEALED_PORTAL_URL_HOSTS = ["courted.io"] as const;
function isConcealedPortalUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.toLowerCase();
  return CONCEALED_PORTAL_URL_HOSTS.some((h) => s.includes(h));
}

export interface DncEntry {
  id: string;
  kind: "agent" | "company";
  name: string;
  email: string | null;
  phone: string | null;
  brokerage: string | null;
  // Company rows carry a normalized blocked domain (added in 0032);
  // agent rows leave this null.
  domain: string | null;
  notes: string | null;
  added_by: string;
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

export interface AgentEntry {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  license: string | null;
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

// Each loader is wrapped in cache() so a single render can fetch them
// once even when several components ask. The portal layout intentionally
// only loads counts; per-page reads happen in the page itself.

export const loadPipelineEntries = cache(
  async (clientId: string): Promise<PipelineEntry[]> => {
    const admin = createAdminSupabase();
    // Pull the pipeline rows + the enriched lead_detail / campaign_name
    // from external_intros via the FK + the lead's custom_fields (so we
    // can derive location/company/website when the snapshot columns are
    // empty). PostgREST flattens these joined rows into nested objects.
    const { data, error } = await admin
      .from("client_pipeline_entries")
      .select(
        "id, stage, custom_stage_key, needs_replacement, lead_name, lead_email, lead_phone, current_brokerage, agent_profile_url, introduced_at, thread_id, assigned_team_member_id, fub_event_id, fub_pushed_at, fub_last_error, source, custom_fields_overrides, assigned_team_member:assigned_team_member_id (id, name), external_intros:external_intro_id (lead_detail, campaign_name), leads:lead_id (custom_fields, company)",
      )
      .eq("client_id", clientId)
      .order("introduced_at", { ascending: false })
      .range(0, 9_999);
    if (error || !data) return [];

    // Second hop: fetch all timestamped notes for the visible entries in
    // one batched query.
    const entryIds = (data as Array<{ id: string }>).map((r) => r.id);
    const notesByEntry = new Map<string, PipelineNote[]>();
    if (entryIds.length > 0) {
      const { data: noteRows } = await admin
        .from("client_pipeline_notes")
        .select("id, entry_id, body, created_at, updated_at")
        .in("entry_id", entryIds)
        .order("created_at", { ascending: false })
        .range(0, 9_999);
      for (const n of (noteRows ?? []) as Array<PipelineNote & { entry_id: string }>) {
        const arr = notesByEntry.get(n.entry_id) ?? [];
        arr.push({ id: n.id, body: n.body, created_at: n.created_at, updated_at: n.updated_at });
        notesByEntry.set(n.entry_id, arr);
      }
    }

    return (data as unknown as Array<
      Omit<
        PipelineEntry,
        | "lead_detail"
        | "campaign_name"
        | "notes_log"
        | "lead_location"
        | "assigned_team_member"
      > & {
        external_intros:
          | { lead_detail: Record<string, unknown> | null; campaign_name: string | null }
          | { lead_detail: Record<string, unknown> | null; campaign_name: string | null }[]
          | null;
        leads:
          | { custom_fields: Record<string, unknown> | null; company: string | null }
          | { custom_fields: Record<string, unknown> | null; company: string | null }[]
          | null;
        assigned_team_member:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }
    >).map((r) => {
      // PostgREST returns the joined row as either a single object or an
      // array depending on cardinality config. Normalise to scalar.
      const ext = Array.isArray(r.external_intros)
        ? r.external_intros[0] ?? null
        : r.external_intros;
      const lead = Array.isArray(r.leads) ? r.leads[0] ?? null : r.leads;
      const cf = (lead?.custom_fields ?? {}) as Record<string, unknown>;
      const extCf = ((ext?.lead_detail as { custom_fields?: Record<string, unknown> } | null)
        ?.custom_fields ?? {}) as Record<string, unknown>;
      // Client-authored per-entry overrides (migration 0057) win over
      // the raw Bison/Instantly enrichment. `?? {}` so a pre-migration
      // row (or a null column) is a no-op — display stays byte-identical
      // to before overrides existed.
      const overrides =
        ((r as { custom_fields_overrides?: Record<string, unknown> | null })
          .custom_fields_overrides ?? {}) as Record<string, unknown>;
      const merged = { ...cf, ...extCf, ...overrides };
      // Portal privacy: drop any custom field whose value points at a
      // concealed host (e.g. courted.io) so no portal surface — the profile
      // link, the editable field grid, the detail drawer — can render it.
      // Only URL-style values match; phone / location / company are untouched.
      for (const k of Object.keys(merged)) {
        if (isConcealedPortalUrl(merged[k])) delete merged[k];
      }
      // Keys present ONLY in the per-entry overrides (absent from both base
      // enrichment sources) are fields the user added manually — the only
      // ones safe to offer for deletion.
      const baseCustomFieldKeys = new Set(
        [...Object.keys(cf), ...Object.keys(extCf)].map((k) => k.toLowerCase()),
      );
      const manualCustomFieldKeys = Object.keys(overrides).filter(
        (k) => !baseCustomFieldKeys.has(k.toLowerCase()),
      );
      const pickStr = (...keys: string[]) => {
        for (const k of keys) {
          const v = merged[k];
          if (v == null) continue;
          const s = String(v).trim();
          if (s && s !== "null" && s !== "undefined") return s;
        }
        return null;
      };

      const {
        external_intros: _ignore1,
        leads: _ignore2,
        assigned_team_member: assignedRaw,
        ...rest
      } = r;
      void _ignore1;
      void _ignore2;
      const assignedTeamMember = Array.isArray(assignedRaw)
        ? assignedRaw[0] ?? null
        : assignedRaw;

      return {
        ...rest,
        current_brokerage:
          rest.current_brokerage ||
          lead?.company ||
          pickStr("companyName", "company", "company_name", "Company", "current_brokerage", "brokerage"),
        agent_profile_url:
          (isConcealedPortalUrl(rest.agent_profile_url)
            ? null
            : rest.agent_profile_url) ||
          pickStr("Agent Profile", "agentProfile", "agent_profile", "website", "Website", "url"),
        lead_location: pickStr(
          "location",
          "Location",
          "city",
          "City",
          "address",
          "Address",
          "market",
          "Market",
        ),
        // Thread the MERGED custom_fields (leads.custom_fields ∪
        // external_intros.lead_detail.custom_fields) so the expanded
        // candidate card surfaces extras for BOTH lead sources:
        //
        //   • legacy external-intros feed → already carried them via
        //     ext.lead_detail.custom_fields.
        //   • Instantly-webhook leads → previously dropped here because
        //     ext.lead_detail was null. Now they ride through.
        //
        // The expanded card's dedup loop skips email/phone/company/
        // title/location, so City, State, LicenseNumber, AgencyZip,
        // Last12Mos_*, etc., render automatically.
        lead_detail: ext?.lead_detail
          ? { ...ext.lead_detail, custom_fields: merged }
          : { custom_fields: merged },
        manual_custom_field_keys: manualCustomFieldKeys,
        campaign_name: ext?.campaign_name ?? null,
        notes_log: notesByEntry.get(rest.id) ?? [],
        assigned_team_member: assignedTeamMember,
      } satisfies PipelineEntry;
    });
  },
);

// Three list loaders. Each pages past Supabase's server-side
// db-max-rows=1000 cap via fetchAllRows — a single .range(0, N)
// call does NOT lift it (the server replies Content-Range: 0-999/N
// no matter what range the client asks for). Without paging, a
// brokerage that imports a 3,400-row CSV only ever sees the first
// 1,000 rows in the UI even though the inserts succeeded.
//
// Each loader keeps its own ordering. fetchAllRows preserves the
// per-window ORDER BY across the concatenated result.

export const loadDncEntries = cache(
  async (clientId: string): Promise<DncEntry[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<DncEntry>(({ from, to }) =>
        admin
          .from("client_dnc_entries")
          .select(
            "id, kind, name, email, phone, brokerage, domain, notes, added_by, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadDncEntries] failed", err);
      return [];
    }
  },
);

export const loadAgentEntries = cache(
  async (clientId: string): Promise<AgentEntry[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<AgentEntry>(({ from, to }) =>
        admin
          .from("client_agents")
          .select(
            "id, name, email, phone, license, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadAgentEntries] failed", err);
      return [];
    }
  },
);

export const loadTeamMembers = cache(
  async (clientId: string): Promise<TeamMember[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<TeamMember>(({ from, to }) =>
        admin
          .from("client_team_members")
          .select(
            "id, name, email, title, phone, receives, active, avatar_url, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: true })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadTeamMembers] failed", err);
      return [];
    }
  },
);

// Counts for the admin overview and the portal sidebar pills. One RPC
// call returns all four counts in a single round-trip — the SQL lives in
// migration 0025 (portal_counts). Cached per-render so the layout +
// page can share the same numbers without re-asking.
export const loadPortalCounts = cache(
  async (clientId: string) => {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .rpc("portal_counts", { client_uuid: clientId })
      .single();
    if (error || !data) {
      return { pipeline: 0, dnc: 0, agents: 0, team: 0 };
    }
    const row = data as {
      pipeline: number | null;
      dnc: number | null;
      agents: number | null;
      team: number | null;
    };
    return {
      pipeline: row.pipeline ?? 0,
      dnc: row.dnc ?? 0,
      agents: row.agents ?? 0,
      team: row.team ?? 0,
    };
  },
);

// Default display labels for the pipeline stage enum. The enum
// values (keep_warm, we_they_rejected) stay frozen in the database
// to avoid a destructive migration; only the user-facing copy
// changes here.
//
// Each client can override any subset of these via the editor on
// the Recruiting Pipeline page — overrides land in
// `clients.stage_label_overrides` (jsonb) and the UI reads the
// merged map through resolveStageLabels() + the StageLabelsProvider
// context in [components/portals/stage-labels-context.tsx]. Anything
// not overridden falls back to the value here.
// Hard cap on a custom label length. Keeps the badges, dropdowns,
// and bulk-action menu from blowing out their column widths.
// Merge per-client overrides over the defaults. Unknown keys and
// empty / whitespace values are ignored so a stale or malformed
// JSON blob can never blank out a label or sneak in a bogus stage.
// Values are trimmed and capped to STAGE_LABEL_MAX_LEN so a very
// long override can't break the layout.
// One-line definitions surfaced in the pipeline legend so clients
// understand what each stage means without asking. Order tracks
// STAGE_ORDER below.
// Per-client visible stages. Filters out stages that are still
// feature-flagged off for this client. Use this anywhere the UI
// renders a stage list (dropdowns, chips, legend, filter pills,
// label editor). The canonical full set in STAGE_ORDER stays
// untouched so `Record<PipelineStage, T>` initialisers and
// exhaustiveness checks keep working.
//
// Today's only gate: `interview_scheduled` is hidden until a
// client carries feature_flags.interview_scheduled_stage = true.
// Default for every existing client is no flag set, so they keep
// seeing the same eight stages as before this change.
// Build a labels map safe to ship across the server→client boundary
// as a React prop. Stages that are NOT in `visibleStages` get their
// user-facing label replaced with the raw enum key (e.g.
// "interview_scheduled" instead of "Interview Scheduled"). The
// Record<PipelineStage, string> shape is preserved so every
// downstream lookup keeps working without conditional handling.
//
// Why: Next.js serialises every server-rendered client component's
// props into a `<script>` payload for hydration. If we pass the
// full `Record<PipelineStage, string>` down to PipelineBoard /
// StageLabelsProvider, the hidden stage's HUMAN label leaks into
// View Source on every real client portal. Replacing the label
// with the enum key keeps that string out of the SSR'd HTML
// entirely — anyone curling the page sees `interview_scheduled` as
// the value, not the polished "Interview Scheduled" copy. Demo Portal
// (the only client with the flag) still receives the full labels.