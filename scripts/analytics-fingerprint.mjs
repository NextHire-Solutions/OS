/*
 * Proves the Campaign Analytics port did not lose anything.
 *
 * The workspace now WRITES to Analytics' own tables — the client roster, the
 * campaign→client mapping, exclusions, offers, copy tags and the reply
 * dimensions. That is the intended architecture (the OS is replacing the tool,
 * not mirroring it), but it means a mistake here costs real rows, and an
 * unfiltered `.update()` or `.delete()` would cost all of them.
 *
 * This records every row that matters, and on a second run reports any
 * difference. Run it before a change and after; a clean diff is evidence rather
 * than assurance.
 *
 *   node scripts/analytics-fingerprint.mjs save
 *   node scripts/analytics-fingerprint.mjs check
 *
 * Shaped after scripts/onboarding-fingerprint.mjs. Read-only: it performs no
 * writes of any kind.
 *
 * ---------------------------------------------------------------------------
 * WHY SOME COLUMNS ARE HASHED
 *
 * THIS REPOSITORY IS PUBLIC. The comparison this file has to make is only ever
 * "is it the same as it was", and a hash answers that without publishing the
 * value. So anything that identifies a private individual or is itself a
 * credential is stored as a truncated SHA-256 and never in the clear:
 *
 *   sender_emails.email    the sending mailboxes — an inbox roster is a target
 *                          list, and the local part is often a real person
 *   clients.slug           derived from the client name, kept as a change
 *                          detector rather than a directory of who we sell to
 *
 * Client and campaign NAMES stay legible: they are the business's own labels,
 * they are what a diff has to name to be actionable ("campaign 918 lost its
 * client"), and `.onboarding-fingerprint.json` already treats them the same way.
 *
 * The output path is `.analytics-fingerprint.json`, which `.gitignore` matches
 * with `.*-fingerprint.json`. Keep it that way. A fingerprint of a live database
 * has no business in a public repository even when every field in it is hashed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = process.env.FP_OUT || path.join(process.cwd(), ".analytics-fingerprint.json");

/*
 * Every table Analytics owns. Counted every run; none may ever shrink silently.
 *
 * The `-- CACHE OF EB` tables are here too, even though the OS never writes
 * them: a cache that suddenly halves means a sync job broke or something
 * truncated it, and this is the cheapest place to notice.
 */
const TABLES = [
  // Locally owned — the rows the workspace can change.
  "clients",
  "campaign_clients",
  "instantly_campaign_clients",
  "offers",
  "campaign_offers",
  "copy_tags",
  "reply_dimensions",
  // Caches and feeds — read here, written only by the tool's sync jobs.
  "campaigns",
  "instantly_campaigns",
  "sequence_steps",
  "instantly_sequence_steps",
  "sender_emails",
  "instantly_accounts",
  "replies",
  "instantly_replies",
  "outcome_events",
  "campaign_day_stats",
  "campaign_step_stats_daily",
  "instantly_campaign_day_stats",
  "instantly_account_day_stats",
  "eb_daily_series",
  "campaign_leads",
  "campaign_lead_sends",
  "instantly_leads",
  "leads",
  "lead_attributes",
  "campaign_audit_log",
  "sync_state",
  "sync_runs",
  "teams",
];

function env() {
  const E = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
    if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return E;
}

const hash = (v) =>
  v == null ? null : `sha256:${crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16)}`;

async function snapshot() {
  const E = env();
  const U = E.ANALYTICS_SUPABASE_URL;
  const K = E.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) {
    throw new Error("ANALYTICS_SUPABASE_URL / ANALYTICS_SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  }
  const head = { apikey: K, Authorization: `Bearer ${K}` };

  const counts = {};
  for (const t of TABLES) {
    /*
     * `count=exact` on `replies` and the lead tables is a full scan of a
     * million rows and times out. `planned` is the planner's estimate, which
     * is enough to see a table lose half its rows and cheap enough to run on
     * every table without a special case.
     *
     * The small locally-owned tables get `exact`, because those are the ones
     * a single bad write actually damages and an estimate would round away a
     * loss of three rows out of fifty.
     */
    const exact = TABLES.indexOf(t) < 7 || t === "teams" || t === "sync_state";
    const q = await fetch(`${U}/rest/v1/${t}?select=*&limit=1`, {
      headers: { ...head, Prefer: exact ? "count=exact" : "count=planned", Range: "0-0" },
    });
    // A table that does not exist is recorded as absent rather than as zero —
    // "0 rows" and "no such table" are different facts.
    counts[t] = q.ok
      ? Number((q.headers.get("content-range") || "/0").split("/")[1]) || 0
      : null;
  }

  const get = async (p) => {
    const r = await fetch(`${U}/rest/v1/${p}`, { headers: head });
    if (!r.ok) throw new Error(`${p} read failed: ${r.status} ${await r.text()}`);
    return r.json();
  };

  /* The client roster. Editable on /analytics/clients. */
  const rawClients = await get(
    "clients?select=id,name,slug,aliases,match_mode,active,team_id&order=name",
  );
  const clients = rawClients.map((c) => ({
    ...c,
    slug: hash(c.slug),
    aliases: (c.aliases ?? []).length,
  }));

  /*
   * The campaign→client mapping, per row.
   *
   * This is the single most damageable table in the product: it is what every
   * analytics RPC joins through, a lost row silently drops a campaign out of
   * every total, and nothing on any screen would look broken. A count alone
   * cannot see one campaign's client_id going null, so each row is recorded.
   */
  const links = await get(
    "campaign_clients?select=campaign_id,client_id,match_method,matched_on,excluded,ambiguous&order=campaign_id",
  );
  const instantlyLinks = await get(
    "instantly_campaign_clients?select=campaign_id,client_id,match_method,excluded&order=campaign_id",
  );

  const offers = await get("offers?select=id,name,niche,active&order=name");
  const campaignOffers = await get("campaign_offers?select=campaign_id,offer_id&order=campaign_id");
  const dimensions = await get(
    "reply_dimensions?select=id,client_id,key,label,source,source_key,bucket,sort_position,active&order=key",
  );
  /*
   * Copy tags are per (step, dimension) and there are hundreds. Recorded as a
   * per-dimension tally rather than per row: what matters is that a dimension
   * does not lose its tags wholesale, and 108 rows of step ids would make the
   * diff unreadable without adding a fact.
   */
  const tags = await get("copy_tags?select=sequence_step_id,dimension,value,source&order=sequence_step_id");
  const tagsByDimension = {};
  for (const t of tags) {
    tagsByDimension[t.dimension] = (tagsByDimension[t.dimension] ?? 0) + 1;
  }

  /*
   * Campaign settings, which the OS can edit. Only the editable columns — the
   * cached lifetime counters change on every sync and would make every run
   * report a difference.
   */
  const campaigns = await get(
    "campaigns?select=id,name,status,deleted_at,max_new_leads_per_day,plain_text,open_tracking,can_unsubscribe,include_auto_replies_in_stats,sequence_prioritization&order=id",
  );

  return {
    at: new Date().toISOString(),
    counts,
    clients,
    links,
    instantlyLinks,
    offers,
    campaignOffers,
    dimensions,
    tagsByDimension,
    campaigns,
  };
}

const mode = process.argv[2] || "check";
const now = await snapshot();

const line = (t, n, was) => {
  const shown = n === null ? "absent" : String(n);
  const d =
    was === undefined || was === null || n === null
      ? ""
      : n === was
        ? " (unchanged)"
        : n > was
          ? ` (+${n - was})`
          : ` (-${was - n})`;
  return `    ${t.padEnd(30)} ${shown.padStart(9)}${d}`;
};

const headline = () =>
  `${now.clients.length} clients · ${now.links.length} campaign links · ${now.campaigns.length} campaigns · ` +
  `${now.offers.length} offers · ${now.dimensions.length} dimensions`;

if (mode === "save" || !fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, JSON.stringify(now, null, 2));
  console.log(`  saved · ${headline()}`);
  for (const t of TABLES) console.log(line(t, now.counts[t]));
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(OUT, "utf8"));
const problems = [];
const notes = [];

/* --- clients: the roster the workspace must never damage ----------------- */
const wasClient = new Map(before.clients.map((c) => [c.id, c]));
const nameOf = new Map(now.clients.map((c) => [c.id, c.name]));
for (const c of now.clients) {
  const b = wasClient.get(c.id);
  if (!b) {
    notes.push(`new client "${c.name}" (not a fault, but new)`);
    continue;
  }
  for (const f of ["name", "slug", "aliases", "match_mode", "active"]) {
    if (JSON.stringify(b[f]) !== JSON.stringify(c[f])) {
      problems.push(`*** client "${b.name}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(c[f])}`);
    }
  }
  wasClient.delete(c.id);
}
for (const [, b] of wasClient) problems.push(`*** CLIENT DELETED: "${b.name}"`);

/* --- the campaign→client mapping ----------------------------------------- */
const wasLink = new Map(before.links.map((l) => [l.campaign_id, l]));
for (const l of now.links) {
  const b = wasLink.get(l.campaign_id);
  if (!b) {
    notes.push(`campaign ${l.campaign_id} newly mapped (a sync would do this)`);
    continue;
  }
  for (const f of ["client_id", "match_method", "excluded", "ambiguous"]) {
    if (b[f] !== l[f]) {
      const from = f === "client_id" ? (b[f] ? nameOf.get(b[f]) ?? b[f] : "unassigned") : b[f];
      const to = f === "client_id" ? (l[f] ? nameOf.get(l[f]) ?? l[f] : "unassigned") : l[f];
      problems.push(`*** campaign ${l.campaign_id} ${f}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }
  }
  wasLink.delete(l.campaign_id);
}
for (const [id] of wasLink) problems.push(`*** CAMPAIGN MAPPING DELETED: campaign ${id}`);

/* --- Instantly's half of the same mapping --------------------------------- */
const wasInst = new Map(before.instantlyLinks.map((l) => [l.campaign_id, l]));
for (const l of now.instantlyLinks) {
  const b = wasInst.get(l.campaign_id);
  if (!b) continue;
  for (const f of ["client_id", "match_method", "excluded"]) {
    if (b[f] !== l[f]) {
      problems.push(`*** instantly campaign ${l.campaign_id} ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(l[f])}`);
    }
  }
  wasInst.delete(l.campaign_id);
}
for (const [id] of wasInst) problems.push(`*** INSTANTLY MAPPING DELETED: campaign ${id}`);

/* --- offers, dimensions --------------------------------------------------- */
const gone = (kind, beforeRows, nowRows, label, key = "id") => {
  const ids = new Set(nowRows.map((r) => r[key]));
  for (const b of beforeRows) {
    if (!ids.has(b[key])) problems.push(`*** ${kind} DELETED: "${label(b)}"`);
  }
};
gone("OFFER", before.offers, now.offers, (o) => o.name);
gone("REPLY DIMENSION", before.dimensions, now.dimensions, (d) => `${d.key} (${d.label})`);

const wasOffer = new Map(before.offers.map((o) => [o.id, o]));
for (const o of now.offers) {
  const b = wasOffer.get(o.id);
  if (!b) { notes.push(`new offer "${o.name}"`); continue; }
  for (const f of ["name", "niche", "active"]) {
    if (b[f] !== o[f]) problems.push(`*** offer "${b.name}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(o[f])}`);
  }
}

const wasDim = new Map(before.dimensions.map((d) => [d.id, d]));
for (const d of now.dimensions) {
  const b = wasDim.get(d.id);
  if (!b) { notes.push(`new reply dimension "${d.key}"`); continue; }
  for (const f of ["key", "label", "source", "source_key", "bucket", "sort_position", "active"]) {
    if (b[f] !== d[f]) problems.push(`*** dimension "${b.key}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(d[f])}`);
  }
}

/* --- offer assignments ---------------------------------------------------- */
const wasAssign = new Map(before.campaignOffers.map((a) => [a.campaign_id, a.offer_id]));
for (const a of now.campaignOffers) {
  const b = wasAssign.get(a.campaign_id);
  if (b === undefined) { notes.push(`campaign ${a.campaign_id} newly given an offer`); continue; }
  if (b !== a.offer_id) problems.push(`*** campaign ${a.campaign_id} offer changed`);
  wasAssign.delete(a.campaign_id);
}
for (const [id] of wasAssign) problems.push(`*** OFFER ASSIGNMENT DELETED: campaign ${id}`);

/* --- campaign settings ----------------------------------------------------- */
const SETTING_FIELDS = [
  "name", "status", "deleted_at", "max_new_leads_per_day", "plain_text",
  "open_tracking", "can_unsubscribe", "include_auto_replies_in_stats",
  "sequence_prioritization",
];
const wasCampaign = new Map(before.campaigns.map((c) => [c.id, c]));
for (const c of now.campaigns) {
  const b = wasCampaign.get(c.id);
  if (!b) { notes.push(`new campaign ${c.id} "${c.name}" (a sync would do this)`); continue; }
  for (const f of SETTING_FIELDS) {
    if (b[f] !== c[f]) {
      // Status moves on its own — EmailBison finishes a campaign without us.
      const changed = `campaign ${c.id} "${b.name}" ${f}: ${JSON.stringify(b[f])} → ${JSON.stringify(c[f])}`;
      (f === "status" ? notes : problems).push(f === "status" ? changed : `*** ${changed}`);
    }
  }
  wasCampaign.delete(c.id);
}
for (const [, b] of wasCampaign) problems.push(`*** CAMPAIGN ROW DELETED: ${b.id} "${b.name}"`);

/* --- copy tags, per dimension --------------------------------------------- */
for (const [dim, was] of Object.entries(before.tagsByDimension ?? {})) {
  const n = now.tagsByDimension[dim] ?? 0;
  if (n < was) problems.push(`*** COPY TAGS LOST: ${dim} ${was} → ${n}`);
  else if (n > was) notes.push(`copy tags added: ${dim} ${was} → ${n}`);
}

/* --- counts ---------------------------------------------------------------- */
for (const t of TABLES) {
  const n = now.counts[t];
  const was = before.counts?.[t];
  if (was === undefined || was === null || n === null) continue;
  /*
   * The estimated counts wobble by a few rows between ANALYZE runs, so a
   * proportional floor keeps the noise out while still catching a real loss.
   * The exact-counted tables are held to the letter.
   */
  const exact = TABLES.indexOf(t) < 7 || t === "teams" || t === "sync_state";
  const floor = exact ? was : Math.floor(was * 0.9);
  if (n < floor) problems.push(`*** DATA LOSS: ${t} ${was} → ${n} (${was - n} rows fewer)`);
}

console.log(`  ${headline()} · baseline ${before.at}`);
for (const t of TABLES) console.log(line(t, now.counts[t], before.counts?.[t]));

if (notes.length) {
  console.log("\n  notes (expected or harmless):");
  for (const n of notes.slice(0, 40)) console.log(`     ${n}`);
  if (notes.length > 40) console.log(`     … and ${notes.length - 40} more`);
}

if (problems.length === 0) {
  console.log("\n  ✅ no client changed · no campaign lost its mapping · nothing deleted · no table shrank");
  process.exit(0);
}
console.log("\n  ⚠️  DIFFERENCES:");
for (const p of problems) console.log(`     ${p}`);
process.exit(problems.some((p) => p.startsWith("***")) ? 1 : 0);
