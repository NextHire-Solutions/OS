import { z } from "zod";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { chunkedRun } from "@/lib/tools/master-inbox/db/chunked-in";

export const dynamic = "force-dynamic";

const schema = z.object({
  thread_ids: z.array(z.string().uuid()).min(1).max(5000),
});

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid input" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = getMasterInboxSupabase();
  // Chunk the .in() so the PostgREST URL stays under Node's header
  // cap regardless of how many ids the operator selects (zod allows
  // up to 5000; the URL form of in.(…) starts to break around 400).
  const chunkResults = await chunkedRun(parsed.data.thread_ids, (slice) =>
    supabase
      .from("threads")
      .select(
        `id, subject, status, last_message_at, message_count,
         leads:lead_id(full_name, email, company, title),
         channels:channel_id(display_name, provider)`,
      )
      .in("id", slice)
      .eq("workspace_id", process.env.MASTER_INBOX_WORKSPACE_ID ?? ""),
  );
  const failed = chunkResults.find((r) => r.error);
  if (failed?.error) {
    return new Response(JSON.stringify({ error: failed.error.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const threads = chunkResults.flatMap((r) => r.data ?? []);

  const headers = [
    "thread_id",
    "subject",
    "status",
    "last_message_at",
    "message_count",
    "lead_name",
    "lead_email",
    "company",
    "title",
    "channel",
  ];
  const lines = [headers.join(",")];

  for (const t of threads ?? []) {
    const lead = Array.isArray(t.leads) ? t.leads[0] : t.leads;
    const channel = Array.isArray(t.channels) ? t.channels[0] : t.channels;
    lines.push(
      [
        t.id,
        csvEscape(t.subject),
        csvEscape(t.status),
        csvEscape(t.last_message_at),
        csvEscape(t.message_count),
        csvEscape(lead?.full_name),
        csvEscape(lead?.email),
        csvEscape(lead?.company),
        csvEscape(lead?.title),
        csvEscape(channel?.display_name ?? channel?.provider),
      ].join(","),
    );
  }

  const csv = lines.join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="threads-${Date.now()}.csv"`,
    },
  });
}
