/*
 * Does every Analytics route actually answer, with real numbers?
 *
 * This project has shipped 23 API routes that returned 401 to everybody, and a
 * settings page whose every field was read-only. Both rendered fine. So this
 * script asks each route the one question a screenshot cannot: did it return
 * data, and does the data have the shape the screen reads?
 *
 *   node scripts/analytics-api-test.mjs [baseUrl]
 *
 * READ-ONLY. Every request here is a GET. The write paths are exercised by
 * scripts/analytics-write-test.mjs, which creates its own rows and deletes them.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3350";

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

const A = "/api/tools/analytics";
const RANGE = "preset=90d";

/*
 * `check` is the point of the file: a route that answers 200 with `{rows: []}`
 * has failed, and only a per-route assertion can say so.
 */
const ROUTES = [
  ["KPI band", `${A}/kpis?${RANGE}&compare=1`, (b) => b.current?.sent > 0 && b.current?.replies > 0],
  ["Filter options", `${A}/filters`, (b) => b.campaigns?.length > 50 && b.clients?.length > 10],
  ["Timeseries", `${A}/timeseries?${RANGE}&compare=1`, (b) => b.points?.length > 30 && b.compare?.length === b.points.length],
  ["Campaign rows", `${A}/campaign-rows?${RANGE}`, (b) => b.rows?.length > 5 && b.rows[0].sent >= 0],
  ["Campaign steps", null, null], // filled in below from the first campaign row
  ["Client rows", `${A}/client-rows?${RANGE}`, (b) => b.rows?.length > 5],
  ["Reply breakdowns", `${A}/replies?${RANGE}`, (b) => b.breakdowns?.length > 0 && b.breakdowns[0].rows?.length > 0],
  ["Reply rows", `${A}/replies/rows?${RANGE}`, (b) => b.total > 0 && b.rows?.length > 0],
  ["Reply facets", `${A}/replies/facets?${RANGE}`, (b) => Object.keys(b.facets ?? {}).length === 3],
  ["Volume", `${A}/volume?${RANGE}&group=client`, (b) => b.total > 0 && b.rows?.length > 0 && b.capacity?.length > 0],
  ["Infrastructure", `${A}/infrastructure?view=domain`, (b) => b.totals?.inboxes > 0 && b.rows?.length > 0],
  ["Infrastructure inboxes", `${A}/infrastructure?view=inbox&limit=500`, (b) => b.rows?.length > 100],
  ["Attribution", `${A}/attribution?${RANGE}`, (b) => b.coverage?.total > 0 && b.funnel?.length > 0],
  ["Attribution events", `${A}/attribution/events?${RANGE}`, (b) => b.total > 0 && b.rows?.length > 0],
  ["Copy performance", `${A}/copy?${RANGE}&dimensions=subject_line`, (b) => b.rows?.length > 0 && b.coverage],
  ["Copy tag values", null, null], // filled in below from a real sequence step
  ["Offers", `${A}/offers?${RANGE}`, (b) => Array.isArray(b.rows)],
  ["Offer suggestions", `${A}/offers/suggestions?${RANGE}`, (b) => Array.isArray(b.suggestions)],
  ["Reply dimensions", `${A}/reply-dimensions`, (b) => b.dimensions?.length > 0],
  ["Merge tags", `${A}/merge-tags`, (b) => b.tags?.length > 3],
  ["Campaigns list", `${A}/campaigns?status=all`, (b) => b.items?.length > 20 && b.total > 20 && b.clients?.length > 10],
  ["Campaign detail", null, null], // filled in below
  ["Campaign leads", null, null], // filled in below
  ["Clients admin", `${A}/clients`, (b) => b.clients?.length > 10],
  ["Schedule", `${A}/schedule?day=today`, (b) => Array.isArray(b.groups)],
  ["Sync status", `${A}/sync/status`, (b) => b.jobs?.length > 5],
  ["Campaign inbox pools", `${A}/campaigns/inboxes?platform=emailbison`, (b) => Array.isArray(b.tags)],
];

async function get(path) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { headers: { cookie: `bs_sso=${cookie}` } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - t0 };
}

let fail = 0;
const line = (ok, label, status, ms, note) => {
  if (!ok) fail++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label.padEnd(24)} ${String(status).padStart(3)}  ${String(ms).padStart(6)}ms  ${note}`,
  );
};

// The first campaign row gives a real id for the three per-campaign routes.
const seedRows = await get(`${A}/campaign-rows?${RANGE}`);
const seedCampaign = (seedRows.body?.rows ?? []).find((r) => typeof r.campaignId === "number");
const seedList = await get(`${A}/campaigns?status=all&platforms=emailbison`);
const seedDetail = (seedList.body?.items ?? [])[0];

for (const [label, path, check] of ROUTES) {
  let p = path;
  let c = check;
  if (label === "Campaign steps") {
    if (!seedCampaign) { line(false, label, "-", 0, "no campaign to drill into"); continue; }
    p = `${A}/campaign-rows/${seedCampaign.campaignId}/steps?${RANGE}`;
    c = (b) => Array.isArray(b.steps);
  }
  if (label === "Campaign detail") {
    if (!seedDetail) { line(false, label, "-", 0, "no campaign in the list"); continue; }
    p = `${A}/campaigns/${seedDetail.id}`;
    c = (b) => b.campaign?.id && Array.isArray(b.sequence);
  }
  if (label === "Copy tag values") {
    const stepId = (seedDetail && (await get(`${A}/campaigns/${seedDetail.id}`)).body?.sequence?.[0]?.id) ?? null;
    if (!stepId) { line(false, label, "-", 0, "no sequence step to tag"); continue; }
    p = `${A}/copy/tags?step_id=${stepId}`;
    c = (b) => b.stepId === stepId && b.known && typeof b.tags === "object";
  }
  if (label === "Campaign leads") {
    if (!seedDetail) { line(false, label, "-", 0, "no campaign in the list"); continue; }
    p = `${A}/campaigns/${seedDetail.id}/leads?facets=1`;
    c = (b) => Array.isArray(b.rows) || Array.isArray(b.facets);
  }

  const { status, body, ms } = await get(p);
  const ok = status === 200 && Boolean(c?.(body ?? {}));
  const note = status !== 200
    ? `ERROR ${JSON.stringify(body?.error ?? body).slice(0, 90)}`
    : ok
      ? summarise(label, body)
      : `200 but the check failed: ${JSON.stringify(body).slice(0, 110)}`;
  line(ok, label, status, ms, note);
}

function summarise(label, b) {
  switch (label) {
    case "KPI band":
      return `sent ${b.current.sent.toLocaleString("en-US")} · replies ${b.current.replies} · positive ${b.current.positive ?? "—"} · prospects ${b.current.prospects?.toLocaleString("en-US") ?? "—"} · follow-up ${b.current.medianFollowUpTime ?? "—"}`;
    case "Filter options":
      return `${b.campaigns.length} campaigns · ${b.clients.length} clients`;
    case "Timeseries":
      return `${b.points.length} days · compare ${b.compare?.length ?? 0}`;
    case "Campaign rows":
      return `${b.rows.length} campaigns · top ${b.rows[0].sent.toLocaleString("en-US")} sent`;
    case "Client rows":
      return `${b.rows.length} clients`;
    case "Reply breakdowns":
      return `${b.breakdowns.length} dimensions · first has ${b.breakdowns[0].rows.length} values`;
    case "Reply rows":
      return `${b.total.toLocaleString("en-US")} replies`;
    case "Volume":
      return `${b.total.toLocaleString("en-US")} sent · ${b.rows.length} rows · ${b.capacity.length} platform(s)`;
    case "Infrastructure":
      return `${b.totals.inboxes} inboxes · ${b.rows.length} domains · bounce ${(100 * (b.totals.bounce_rate ?? 0)).toFixed(2)}%`;
    case "Infrastructure inboxes":
      return `${b.rows.length} of ${b.total} inboxes`;
    case "Attribution":
      return `${b.coverage.total} outcomes · ${b.campaigns.length} campaigns · ${b.emailsSent.toLocaleString("en-US")} sent`;
    case "Attribution events":
      return `${b.total} events · ${b.rows.length} on page 1`;
    case "Copy performance":
      return `${b.rows.length} groups · coverage ${b.coverage.tagged_sent}/${b.coverage.total_sent}`;
    case "Copy tag values":
      return `step ${b.stepId} · ${Object.keys(b.tags ?? {}).length} tag(s) · ${Object.keys(b.known ?? {}).length} dimensions of known values`;
    case "Offers":
      return `${b.rows.length} offers`;
    case "Offer suggestions":
      return `${b.suggestions.length} suggestions`;
    case "Reply dimensions":
      return `${b.dimensions.length} dimensions`;
    case "Merge tags":
      return `${b.tags.length} tags`;
    case "Campaigns list":
      return `${b.items.length} of ${b.total} · ${b.clients.length} clients`;
    case "Campaign detail":
      return `"${String(b.campaign.name).slice(0, 34)}" · ${b.sequence.length} steps`;
    case "Campaign leads":
      return `${b.total ?? 0} leads · ${b.facets?.length ?? 0} facets`;
    case "Clients admin":
      return `${b.clients.length} clients · ${b.unassigned.length} unassigned · ${b.excludedCount} excluded`;
    case "Schedule":
      return `${b.groups.length} clients · ${b.total ?? 0} emails${b.error ? ` · ${b.error}` : ""}`;
    case "Sync status":
      return `${b.jobs.length} jobs · healthy ${b.healthy} · degraded ${b.degraded.length}`;
    case "Campaign inbox pools":
      return `${b.tags.length} pools`;
    default:
      return "ok";
  }
}

console.log(`\n  ${ROUTES.length - fail}/${ROUTES.length} routes returned real data`);
process.exit(fail ? 1 : 0);
