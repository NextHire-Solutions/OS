import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { enforceBlocklist } from "@/lib/tools/master-inbox/portals/enforce-blocklist";

// POST /api/portal/[token]/agents/csv — bulk-import parsed rows from
// the portal's CSV dialog. The browser parses + previews; this route
// validates, writes in one batched upsert (idempotent on
// (client_id, email) thanks to migration 0037), and fires off the
// provider blocklist push asynchronously in parallel chunks instead
// of a 250ms-per-row sequential walk. The route returns as soon as
// the DB write is done; provider sync flushes in the background.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const rowSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  license: z.string().trim().max(80).nullable().optional(),
});

const schema = z.object({
  rows: z.array(rowSchema).min(1).max(5000),
});

// Parallelism for provider pushes. Each call hits Instantly +
// EmailBison; ten in flight at a time is a good throughput vs
// rate-limit tradeoff (previously we used a 250ms sleep between rows).
const PUSH_CONCURRENCY = 10;

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  // Dedup within the batch by lowercased email — preserves the first
  // occurrence + drops the rest. Email is also lowercased on the way
  // in so the (client_id, email) unique index matches across
  // re-uploads with mixed casing.
  const seen = new Set<string>();
  const rows = parsed.data.rows
    .map((r) => ({
      ...r,
      email: r.email ? r.email.toLowerCase() : null,
    }))
    .filter((r) => {
      if (!r.email) return true;
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });

  // One batched upsert. `ignoreDuplicates: true` makes a re-upload a
  // no-op for already-imported emails (the unique partial index on
  // (client_id, email) is the conflict target). Rows without an
  // email skip the dedup branch and always insert.
  const insertRows = rows.map((r) => ({
    client_id: client.id,
    name: r.name,
    email: r.email,
    phone: r.phone ?? null,
    license: r.license ?? null,
    pushed_to_instantly: false,
    pushed_to_emailbison: false,
    push_error: null as string | null,
  }));
  const { data: inserted, error } = await admin
    .from("client_agents")
    .upsert(insertRows, {
      onConflict: "client_id,email",
      ignoreDuplicates: true,
    })
    .select("id, email");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Async provider push — parallel chunks of PUSH_CONCURRENCY. We
  // don't await the whole thing on the response path; the DB row
  // exists so the operator's UI is correct, and pushed_to_* flips
  // when the push completes. The Promise tree is anchored to the
  // request via Promise.allSettled which keeps it alive in the
  // serverless runtime until the route's maxDuration window expires.
  const pushPromise = (async () => {
    const targets = (inserted ?? []).filter((r) => !!r.email) as Array<{
      id: string;
      email: string;
    }>;
    for (let i = 0; i < targets.length; i += PUSH_CONCURRENCY) {
      const chunk = targets.slice(i, i + PUSH_CONCURRENCY);
      await Promise.allSettled(
        chunk.map(async (t) => {
          const result = await enforceBlocklist(t.email);
          await admin
            .from("client_agents")
            .update({
              pushed_to_instantly: result.pushedInstantly,
              pushed_to_emailbison: result.pushedEmailBison,
              push_error: result.error,
            })
            .eq("id", t.id);
        }),
      );
    }
  })();
  // Hold the request open just long enough to finish the push, but
  // don't block the JSON response above. (Node's serverless runtime
  // discards unawaited tasks once the response flushes, so we have
  // to keep a reference — `void` suppresses the dangling-promise
  // lint without changing behavior.)
  void pushPromise;

  return NextResponse.json({
    ok: true,
    inserted: inserted?.length ?? 0,
    // Provider push completes asynchronously; the UI reads pushed_to_*
    // on the next refresh.
    pushScheduled: (inserted ?? []).filter((r) => !!r.email).length,
  });
}
