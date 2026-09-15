import { NextResponse, after } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { clientHasFeature } from "@/lib/tools/master-inbox/portals/feature-flags";
import { notifyIntroduction } from "@/lib/tools/master-inbox/webhooks/n8n-introduction";
import { pushPipelineEntryToFub } from "@/lib/tools/master-inbox/integrations/push-pipeline-entry";
import { parseCsv, csvRowToPipeline } from "@/lib/tools/master-inbox/portals/csv";

// POST /api/portal/[token]/pipeline/csv — bulk-import leads from a
// CSV uploaded via the portal "Upload CSV" button. Mirrors the
// Agents / DNC / Team importers: the client parses the CSV with
// the shared parseCsv util and posts `{ rows: PipelineCsvRow[] }`.
// This route trusts the rows (validated client-side via the same
// schema-shape), re-validates lightly (stage union, email format),
// and inserts them.
//
// Gated behind the pipeline_csv_upload feature flag — clients
// without it get a vanilla 404 (no info leak about a hidden
// route).
//
// Returns { inserted: N, skipped: [{row, reason}] } — same shape
// as the upload-dialog UI expects.

export const dynamic = "force-dynamic";

const STAGES = new Set([
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
  "keep_warm",
  "we_they_rejected",
  "no_show",
]);

const MAX_ROWS = 5000;

interface SkippedRow {
  row: number;
  reason: string;
}

interface IncomingRow {
  lead_name: string;
  lead_email: string | null;
  lead_phone: string | null;
  current_brokerage: string | null;
  agent_profile_url: string | null;
  introduced_at: string | null;
  stage: string | null;
  needs_replacement: boolean;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  if (!clientHasFeature(client, "pipeline_csv_upload")) {
    // Real clients without the flag see this as a normal 404 — no
    // signal that the route exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Accept either the new JSON body { rows: [...] } from the
  // dashed-drop-zone dialog (Agents / DNC style), or a legacy
  // multipart `file` upload for backward compatibility with the
  // CSV dialog that shipped yesterday — parse on the server in
  // that case using the same csvRowToPipeline mapper.
  const ctype = request.headers.get("content-type") ?? "";
  let parsedRows: IncomingRow[] = [];
  if (ctype.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.rows)) {
      return NextResponse.json({ error: "Missing rows array" }, { status: 400 });
    }
    parsedRows = body.rows as IncomingRow[];
  } else {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "CSV file is too large (max 5 MB)" },
        { status: 400 },
      );
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    parsedRows = parsed
      .map(csvRowToPipeline)
      .filter((r): r is IncomingRow => Boolean(r));
  }

  if (parsedRows.length === 0) {
    return NextResponse.json({ inserted: 0, skipped: [] });
  }
  if (parsedRows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `CSV exceeds the ${MAX_ROWS}-row limit. Split it and upload in batches.` },
      { status: 400 },
    );
  }

  // Per-row server-side validation. We mirror only the rules that
  // matter for data integrity — stage must be one of the known
  // enums, email (if present) must be sane. Everything else is
  // accepted as-is since the column types are forgiving.
  const skipped: SkippedRow[] = [];
  const valid: IncomingRow[] = [];
  parsedRows.forEach((r, i) => {
    const lineNo = i + 1;
    if (!r.lead_name || !r.lead_name.trim()) {
      skipped.push({ row: lineNo, reason: "lead_name is required" });
      return;
    }
    if (r.lead_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.lead_email)) {
      skipped.push({ row: lineNo, reason: `Invalid email: ${r.lead_email}` });
      return;
    }
    const stage = (r.stage ?? "introduction").toLowerCase();
    if (!STAGES.has(stage)) {
      skipped.push({ row: lineNo, reason: `Unknown stage: ${r.stage}` });
      return;
    }
    let introducedIso: string | null = null;
    if (r.introduced_at) {
      const d = new Date(r.introduced_at);
      if (Number.isNaN(d.getTime())) {
        skipped.push({ row: lineNo, reason: `Invalid date: ${r.introduced_at}` });
        return;
      }
      introducedIso = d.toISOString();
    }
    valid.push({ ...r, stage, introduced_at: introducedIso });
  });

  if (valid.length === 0) {
    return NextResponse.json({ inserted: 0, skipped });
  }

  // CSV-imported rows always land as "Client Entry" when the
  // source-split flag is on. With only the CSV flag on (source
  // split still off), the column default 'BrokerStaffer' applies
  // — same convention as the manual "Add candidate" form.
  const includeSource = clientHasFeature(client, "pipeline_source_split");

  const admin = createAdminSupabase();
  const insertRows = valid.map((r) => ({
    client_id: client.id,
    stage: r.stage,
    needs_replacement: r.needs_replacement,
    lead_name: r.lead_name,
    lead_email: r.lead_email,
    lead_phone: r.lead_phone,
    current_brokerage: r.current_brokerage,
    agent_profile_url: r.agent_profile_url,
    introduced_at: r.introduced_at ?? new Date().toISOString(),
    ...(includeSource ? { source: "Client Entry" } : {}),
  }));

  const { data: inserted, error } = await admin
    .from("client_pipeline_entries")
    .insert(insertRows)
    .select("id, stage");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Introduction-stage handling: identical to the single-row POST.
  // n8n notify + FUB auto-push for every row that lands as
  // Introduction. Runs inside after() so the response returns
  // immediately even on big imports.
  const introIds = (inserted ?? [])
    .filter((r) => (r as { stage: string }).stage === "introduction")
    .map((r) => (r as { id: string }).id);
  if (introIds.length > 0) {
    after(() => notifyIntroduction(introIds, "portal_csv_upload"));
    if (client.fub_api_key_set) {
      const clientId = client.id;
      after(async () => {
        for (const id of introIds) {
          try {
            await pushPipelineEntryToFub(clientId, id);
          } catch (err) {
            console.error("[fub] csv auto-push failed", id, err);
          }
        }
      });
    }
  }

  return NextResponse.json({
    inserted: inserted?.length ?? 0,
    skipped,
  });
}
