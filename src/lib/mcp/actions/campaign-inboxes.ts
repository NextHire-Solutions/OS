import "server-only";

import { randomUUID } from "node:crypto";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { leftOutWords, RULE_WORDS } from "@/lib/tools/analytics/campaigns/attach-health.ts";
import { readAttachHealth } from "@/lib/tools/analytics/campaigns/attach-health-io";
import { runInboxAdd } from "@/lib/tools/analytics/campaigns/inbox-add-run";
import { isOpenStatus } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";
import { resolveEbCampaign } from "./campaign-one.ts";

/*
 * Add inboxes to ONE campaign through Claude (27 Nov, the Campaigns group): the Inboxes page's "Add to campaigns"
 * (campaigns/inbox-add-run.ts, the same run), so only healthy inboxes go on (attach-health.ts: connected, not tagged
 * Dead, bounce under 2%, warm-up 90+), judged again when it runs, and it is named in the audit log ("from: Claude").
 * The inboxes are named by a tag (as the Inboxes page's Tags filter has them) or by their addresses. Adding never takes
 * an inbox off anything; one already on the campaign stays as it is.
 */

const MAX = 10_000;
const n = (v: number) => v.toLocaleString("en-US");
const inboxes = (v: number) => `${n(v)} inbox${v === 1 ? "" : "es"}`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Args = { campaign: string; tag?: string; emails?: string[] };
type Bind = { id: number; healthy: number[] };
type Inbox = { id: number; email: string; tags: string[] };

/** Every inbox the inbox sync holds now (deleted ones left out), page by page. */
async function allInboxes(): Promise<Inbox[]> {
  const sb = getAnalyticsSupabase();
  const out: Inbox[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await sb.from("sender_emails").select("id, email, tags").eq("team_id", analyticsTeamId()).is("archived_at", null).order("id").range(from, from + 999);
    if (error) throw new Error(`Inboxes could not be read: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: unknown; email: unknown; tags: unknown }>;
    for (const r of rows) {
      out.push({
        id: Number(r.id),
        email: String(r.email ?? "").trim().toLowerCase(),
        tags: (Array.isArray(r.tags) ? r.tags : []).map((t) => (typeof t === "string" ? t : String((t as { name?: unknown })?.name ?? ""))).filter(Boolean),
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** The inboxes asked for, or why not; with the addresses not found. */
async function selection(a: Args): Promise<{ ids: number[]; what: string; notFound: string[]; emailOf: Map<number, string> } | { error: string }> {
  const all = await allInboxes();
  const emailOf = new Map(all.map((i) => [i.id, i.email]));
  if (a.tag) {
    const t = a.tag.trim().toLowerCase();
    const hit = all.filter((i) => i.tags.some((x) => x.trim().toLowerCase() === t));
    if (!hit.length) {
      const near = [...new Set(all.flatMap((i) => i.tags).filter((x) => x.toLowerCase().includes(t.split(/\s+/)[0] ?? t)))].slice(0, 8);
      return { error: `No inbox is tagged "${a.tag}".${near.length ? ` Tags like it: ${near.join(", ")}.` : ""}` };
    }
    return { ids: hit.map((i) => i.id), what: `tagged "${a.tag}"`, notFound: [], emailOf };
  }
  const byEmail = new Map(all.map((i) => [i.email, i.id]));
  const ids: number[] = [];
  const notFound: string[] = [];
  for (const e of a.emails ?? []) {
    const id = byEmail.get(e);
    if (id === undefined) notFound.push(e);
    else ids.push(id);
  }
  if (!ids.length) return { error: `None of those addresses is an inbox EmailBison has: ${notFound.slice(0, 10).join(", ")}.` };
  return { ids: [...new Set(ids)], what: `of the ${n(a.emails!.length)} address${a.emails!.length === 1 ? "" : "es"} given`, notFound, emailOf };
}

export const campaignAddInboxes: ActionSpec<Args, Bind> = {
  name: "campaign_add_inboxes",
  title: "Add inboxes to one campaign",
  description:
    "Add sending inboxes to ONE EmailBison campaign, as the Inboxes page's Add to campaigns does: name them by a tag " +
    "(tag) or by their addresses (emails). Only healthy inboxes go on — connected, not tagged Dead, bounce rate under " +
    "2% over 30 days, warm-up score 90+ over 14 days; the preview says how many go on and why any are left out. " +
    "Nothing is taken off the campaign.",
  inputSchema: {
    type: "object",
    properties: {
      campaign: { type: "string", description: "The campaign's name or number." },
      tag: { type: "string", description: "Add the inboxes with this tag (as the Inboxes page's Tags filter shows it)." },
      emails: { type: "array", items: { type: "string" }, description: "Or: add these inboxes, by address." },
    },
    required: ["campaign"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  needs: (grantsForRequest("/api/tools/analytics/campaigns/inboxes/add/run", "POST") ?? []) as ToolId[],
  parse(a) {
    const campaign = String(a.campaign ?? "").trim();
    if (!campaign) return { error: "Which campaign? Give its name or number." };
    const tag = typeof a.tag === "string" && a.tag.trim() ? a.tag.trim() : undefined;
    const emails = Array.isArray(a.emails) ? [...new Set(a.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : [];
    if (tag && emails.length) return { error: "Give a tag OR addresses, not both." };
    if (!tag && !emails.length) return { error: "Which inboxes? Give a tag, or their addresses." };
    const bad = emails.filter((e) => !EMAIL.test(e));
    if (bad.length) return { error: `Not email addresses: ${bad.slice(0, 5).join(", ")}.` };
    if (emails.length > MAX) return { error: `At most ${n(MAX)} addresses at once.` };
    return tag ? { campaign, tag } : { campaign, emails };
  },
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    const eb = createEmailBisonClient();
    const live = String((await eb.getCampaign(c.id)).status ?? c.status).toLowerCase();
    if (!isOpenStatus(live)) return { ok: false, refusal: `${c.name} (#${c.id}) is ${live}: inboxes go only on a campaign that can still send.` };
    const sel = await selection(a);
    if ("error" in sel) return { ok: false, refusal: sel.error };
    if (sel.ids.length > MAX) return { ok: false, refusal: `That is ${n(sel.ids.length)} inboxes — at most ${n(MAX)} at once.` };
    const read = await readAttachHealth(sel.ids);
    if (!read.ok) return { ok: false, refusal: `Inbox health could not be read just now, so nothing can be added: ${read.error}` };
    const { healthy, counts, leftOut } = read.health;
    const missing = sel.notFound.length ? ` Not inboxes EmailBison has: ${sel.notFound.slice(0, 10).join(", ")}${sel.notFound.length > 10 ? ", …" : ""}.` : "";
    if (!healthy.length) return { ok: false, refusal: `None of the ${inboxes(sel.ids.length)} ${sel.what} passes the health rules (${leftOutWords(counts)}), so nothing would go on. ${RULE_WORDS}${missing}` };
    const now = await eb.getCampaignSenderEmailCount(c.id).catch(() => null);
    const emailOf = sel.emailOf;
    return {
      ok: true,
      preview:
        `Add ${inboxes(healthy.length)} ${sel.what} to "${c.name}" (#${c.id}, ${live}${now === null ? "" : `, ${inboxes(now)} on it now`}).` +
        (leftOut.length ? ` Left out by the health rules: ${leftOutWords(counts)}.` : "") + missing +
        " Any already on it stay as they are; nothing is taken off.",
      details: { adding: healthy.slice(0, 50).map((id) => emailOf.get(id) ?? `#${id}`), more: Math.max(0, healthy.length - 50), leftOut: leftOut.slice(0, 50).map((x) => `${x.email}: ${x.reasons.join(", ")}`) },
      bind: { id: c.id, healthy: [...healthy].sort((x, y) => x - y) },
    };
  },
  async execute(_a, v, bind) {
    const r = await runInboxAdd({ campaignId: bind.id, inboxIds: bind.healthy, batchId: randomUUID(), actor: `${v.email} via Claude`, from: "Claude" });
    const b = r.body as { ok?: boolean; error?: string; added?: number; alreadyOn?: number; before?: number | null; after?: number | null; leftOutUnhealthy?: number; dropped?: number; outcome?: string; name?: string };
    if (r.status !== 200 || b.ok === false) throw new Error(b.error ?? "The inboxes could not be added.");
    if (b.outcome === "finished") throw new Error("The campaign finished before the inboxes went on; nothing was added.");
    console.info(`[mcp-action] ${v.email} via Claude: added ${b.added ?? 0} inboxes to campaign #${bind.id}`);
    return { campaign: b.name, number: bind.id, outcome: b.outcome, added: b.added, alreadyOn: b.alreadyOn, inboxesBefore: b.before, inboxesAfter: b.after, leftOutByHealthNow: b.leftOutUnhealthy ?? 0, unknownToEmailBison: b.dropped ?? 0 };
  },
};
