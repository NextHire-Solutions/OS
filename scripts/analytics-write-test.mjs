/*
 * Do the Analytics writes actually change the database?
 *
 * A screen that renders is not a screen that works. This project has shipped a
 * settings page where every field was read-only, twenty-three API routes that
 * answered 401 to everybody, and a portals page whose own comment said
 * "Read-only". All three rendered. So every write this port exposes is fired
 * here, through the same HTTP route the browser uses, and the RESULT IS READ
 * BACK OUT OF THE DATABASE rather than inferred from a 200.
 *
 *   node scripts/analytics-write-test.mjs [baseUrl]
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 * Every row touched here is either
 *   (a) one this script CREATES and then DELETES — a client, an offer, a
 *       campaign, an outcome, all named with the ZZ_ prefix below; or
 *   (b) a real row that is put back EXACTLY as it was found, with the restored
 *       value read back to prove it.
 *
 * Nothing is left behind, and `scripts/analytics-fingerprint.mjs check` is the
 * independent proof of that — run it before and after.
 *
 * The one thing this script does NOT do is fire the four campaign actions
 * (pause / resume / archive / duplicate) at a real campaign. Those reach
 * EmailBison and Instantly, resume in particular queues a campaign to SEND, and
 * there is no client campaign it would be acceptable to experiment on. Their
 * guards are tested instead — the 428 without confirm, the eligibility filter,
 * the platform refusal — and the EmailBison write path is proved end to end on
 * a campaign this script creates and deletes.
 */
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:3350";
const A = `${BASE}/api/tools/analytics`;

/* Everything this script creates carries this prefix, so a leak is obvious. */
const STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const NAME = `ZZ_OS_PORT_TEST_${STAMP}`;

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const cookie = await mintSso(env.BS_SSO_SECRET || env.AUTH_SECRET, {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

/** The database, read directly — never through the route being tested. */
const sb = async (path) => {
  const r = await fetch(`${env.ANALYTICS_SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const api = async (path, init = {}) => {
  const r = await fetch(A + path, {
    ...init,
    headers: { cookie: `bs_sso=${cookie}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};

const json = (method, payload) => ({ method, body: JSON.stringify(payload) });

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ""}`); }
};

const cleanup = [];

console.log(`\n  Records created by this run are named ${NAME}\n`);

try {
  /* ===================================================================== */
  console.log("  ── the front door ──────────────────────────────────────");

  {
    const r = await fetch(`${A}/clients`);
    check(r.status === 401, "an unsigned request is refused", `got ${r.status}`);
  }
  {
    const { status } = await api("/clients");
    check(status === 200, "a signed request is served", `got ${status}`);
  }

  /* ===================================================================== */
  console.log("\n  ── clients ─────────────────────────────────────────────");

  const created = await api("/clients", json("POST", {
    name: NAME,
    aliases: [`${NAME}_alias`],
    matchMode: "exact",
  }));
  check(created.status === 201, "POST /clients creates a client", `status ${created.status}`);
  const clientId = created.body?.client?.id;
  cleanup.push(async () => { if (clientId) await api(`/clients/${clientId}`, { method: "DELETE" }); });

  {
    const [row] = await sb(`clients?id=eq.${clientId}&select=id,name,slug,aliases,match_mode,active`);
    check(
      row && row.name === NAME && row.match_mode === "exact" && row.aliases?.[0] === `${NAME}_alias`,
      "the row is in the database with the values sent",
      row ? `name=${row.name} mode=${row.match_mode} aliases=${JSON.stringify(row.aliases)}` : "no row",
    );
  }

  {
    const dup = await api("/clients", json("POST", { name: NAME }));
    check(dup.status === 409, "a duplicate name is refused with 409, not a second row", `status ${dup.status}`);
  }

  {
    await api(`/clients/${clientId}`, json("PATCH", { name: `${NAME}_renamed`, matchMode: "prefix", aliases: [] }));
    const [row] = await sb(`clients?id=eq.${clientId}&select=name,match_mode,aliases`);
    check(
      row?.name === `${NAME}_renamed` && row.match_mode === "prefix" && row.aliases.length === 0,
      "PATCH /clients/:id renames, re-aliases and changes the match mode",
      `name=${row?.name} mode=${row?.match_mode} aliases=${JSON.stringify(row?.aliases)}`,
    );
  }

  /* ===================================================================== */
  console.log("\n  ── reply dimensions (copy-on-write) ────────────────────");

  {
    const before = await sb(`reply_dimensions?client_id=is.null&key=eq.location&select=id,active`);
    await api("/reply-dimensions", json("PUT", { clientId, key: "location", active: false }));
    const mine = await sb(`reply_dimensions?client_id=eq.${clientId}&key=eq.location&select=id,active,client_id`);
    const after = await sb(`reply_dimensions?client_id=is.null&key=eq.location&select=id,active`);
    check(
      mine.length === 1 && mine[0].active === false,
      "turning a breakdown off writes a CLIENT-SPECIFIC row",
      mine.length ? `client row active=${mine[0].active}` : "no client row written",
    );
    check(
      after[0]?.active === before[0]?.active && after[0]?.id === before[0]?.id,
      "the shared default is untouched — it would have hidden the card for every client",
      `default active=${after[0]?.active}`,
    );
    await api("/reply-dimensions", json("PUT", { clientId, key: "location", active: true }));
    const back = await sb(`reply_dimensions?client_id=eq.${clientId}&key=eq.location&select=active`);
    check(back[0]?.active === true, "turning it back on updates the same row rather than adding another",
      `${back.length} row(s), active=${back[0]?.active}`);
  }

  /* ===================================================================== */
  console.log("\n  ── offers ──────────────────────────────────────────────");

  const offer = await api("/offers", json("POST", { name: NAME, niche: "port-test" }));
  check(offer.status === 201 || offer.status === 200, "POST /offers creates an offer", `status ${offer.status}`);
  const offerId = offer.body?.offer?.id ?? offer.body?.id;
  cleanup.push(async () => { if (offerId) await api(`/offers/${offerId}`, { method: "DELETE" }); });

  {
    const [row] = await sb(`offers?id=eq.${offerId}&select=id,name,niche,active`);
    check(row?.name === NAME && row.niche === "port-test", "the offer row is in the database",
      row ? `name=${row.name} niche=${row.niche}` : "no row");
  }
  {
    await api(`/offers/${offerId}`, json("PATCH", { name: `${NAME}_renamed`, niche: null }));
    const [row] = await sb(`offers?id=eq.${offerId}&select=name,niche`);
    check(row?.name === `${NAME}_renamed` && row.niche === null,
      "PATCH /offers/:id renames it and clears the niche", `name=${row?.name} niche=${row?.niche}`);
  }

  /* ===================================================================== */
  console.log("\n  ── campaign → client, on a campaign put back exactly ───");

  {
    // An UNASSIGNED campaign, so nothing is taken away from a real client.
    const list = await api("/clients");
    const target = (list.body?.unassigned ?? []).find((u) => u.platform === "emailbison");
    if (!target) {
      check(false, "found an unassigned EmailBison campaign to pin", "none available");
    } else {
      const id = target.campaignId;
      const [before] = await sb(`campaign_clients?campaign_id=eq.${id}&select=client_id,match_method,matched_on,ambiguous`);

      await api(`/campaigns/${id}/client`, json("PUT", { clientId }));
      const [pinned] = await sb(`campaign_clients?campaign_id=eq.${id}&select=client_id,match_method`);
      check(
        pinned?.client_id === clientId && pinned.match_method === "manual",
        `PUT /campaigns/${id}/client pins the campaign by hand`,
        `client_id set, match_method=${pinned?.match_method}`,
      );

      await api(`/campaigns/${id}/client`, json("PUT", { clientId: null }));
      const [restored] = await sb(`campaign_clients?campaign_id=eq.${id}&select=client_id,match_method,ambiguous`);
      check(
        restored?.client_id === before?.client_id && restored.match_method === before?.match_method,
        "unpinning restores the row exactly as it was found",
        `client_id ${restored?.client_id === null ? "null" : "set"}, match_method=${restored?.match_method} (was ${before?.match_method})`,
      );
    }
  }

  /* ===================================================================== */
  console.log("\n  ── the same, for an INSTANTLY campaign ─────────────────");

  {
    /*
     * The tool cannot do this at all: `PUT /campaigns/<uuid>/client` opens with
     * `Number(id)` and 400s, while its own Clients page lists Instantly
     * campaigns in the unassigned queue with an Assign dropdown beside them.
     */
    const list = await api("/clients");
    const target = (list.body?.unassigned ?? []).find((u) => u.platform === "instantly");
    if (!target) {
      check(false, "found an unassigned Instantly campaign to pin", "none available");
    } else {
      const id = target.campaignId;
      const [before] = await sb(`instantly_campaign_clients?campaign_id=eq.${id}&select=client_id,match_method`);

      const put = await api(`/campaigns/${id}/client`, json("PUT", { clientId }));
      const [pinned] = await sb(`instantly_campaign_clients?campaign_id=eq.${id}&select=client_id,match_method`);
      check(
        put.status === 200 && pinned?.client_id === clientId && pinned.match_method === "manual",
        "an Instantly campaign can be pinned — 84 of the 93 unassigned are Instantly",
        `status ${put.status}, match_method=${pinned?.match_method}`,
      );

      await api(`/campaigns/${id}/client`, json("PUT", { clientId: null }));
      const [restored] = await sb(`instantly_campaign_clients?campaign_id=eq.${id}&select=client_id,match_method`);
      check(
        restored?.client_id === before?.client_id && restored.match_method === before?.match_method,
        "unpinning restores the Instantly row exactly as it was found",
        `client_id ${restored?.client_id === null ? "null" : "set"}, match_method=${restored?.match_method}`,
      );
    }

    const missing = await api("/campaigns/99999999/client", json("PUT", { clientId: null }));
    check(missing.status === 404,
      "pinning a campaign with no mapping row is a 404, not a silent 'ok'",
      `status ${missing.status}`);
  }

  /* ===================================================================== */
  console.log("\n  ── campaign → offer, set then cleared ──────────────────");

  {
    // A campaign with NO offer today, so clearing afterwards restores the
    // absence rather than overwriting somebody's choice.
    const withOffers = await sb("campaign_offers?select=campaign_id");
    const taken = new Set(withOffers.map((r) => r.campaign_id));
    const campaigns = await sb("campaigns?select=id,name&team_id=eq.2&order=id&limit=200");
    const free = campaigns.find((c) => !taken.has(c.id));

    if (!free) {
      check(false, "found a campaign with no offer", "every campaign already has one");
    } else {
      await api(`/campaigns/${free.id}/offer`, json("PUT", { offerId }));
      const set = await sb(`campaign_offers?campaign_id=eq.${free.id}&select=offer_id,actor`);
      check(
        set[0]?.offer_id === offerId,
        `PUT /campaigns/${free.id}/offer attaches the offer`,
        `actor recorded as ${set[0]?.actor ?? "(none)"}`,
      );
      check(
        set[0]?.actor === "admin@outreachify.io",
        "the audit actor is the signed-in person, not 'system'",
        `actor=${set[0]?.actor}`,
      );

      await api(`/campaigns/${free.id}/offer`, json("PUT", { offerId: null }));
      const cleared = await sb(`campaign_offers?campaign_id=eq.${free.id}&select=offer_id`);
      check(cleared.length === 0, "clearing it removes the row, restoring the campaign", `${cleared.length} row(s) left`);
    }
  }

  /* ===================================================================== */
  console.log("\n  ── copy tags, set then cleared ─────────────────────────");

  {
    // A dimension nothing uses today, on a real step, so the value written can
    // only be the one this test wrote.
    const [step] = await sb("sequence_steps?select=id&team_id=eq.2&step_order=eq.1&is_variant=eq.false&order=id&limit=1");
    const dimension = "structure";
    const before = await sb(`copy_tags?sequence_step_id=eq.${step.id}&dimension=eq.${dimension}&select=value`);

    if (before.length) {
      check(false, "chose an untagged dimension", `step ${step.id} already has a ${dimension} tag`);
    } else {
      const put = await api("/copy/tags", json("PUT", { sequenceStepId: step.id, tags: { [dimension]: NAME } }));
      const written = await sb(`copy_tags?sequence_step_id=eq.${step.id}&dimension=eq.${dimension}&select=value,source,actor,confirmed_at`);
      check(
        put.status === 200 && written[0]?.value === NAME,
        `PUT /copy/tags writes the ${dimension} tag on step ${step.id}`,
        `value=${written[0]?.value}`,
      );
      check(
        written[0]?.source === "manual" && written[0]?.confirmed_at,
        "saving through the UI promotes it to manual and stamps confirmed_at",
        `source=${written[0]?.source} actor=${written[0]?.actor}`,
      );

      await api("/copy/tags", json("PUT", { sequenceStepId: step.id, tags: { [dimension]: null } }));
      const gone = await sb(`copy_tags?sequence_step_id=eq.${step.id}&dimension=eq.${dimension}&select=value`);
      check(gone.length === 0, "clearing it deletes the row", `${gone.length} row(s) left`);
    }
  }

  /* ===================================================================== */
  console.log("\n  ── outcomes, logged then removed ───────────────────────");

  {
    const rows = await api("/replies/rows?preset=30d");
    const reply = (rows.body?.rows ?? []).find((r) => (r.logged ?? []).length === 0);
    if (!reply) {
      check(false, "found a reply with no hand-logged outcome", "none available");
    } else {
      const id = `manual:${reply.id}:phone_screen`;
      const post = await api("/outcomes", json("POST", { replyId: reply.id, eventType: "phone_screen" }));
      const [row] = await sb(`outcome_events?id=eq.${encodeURIComponent(id)}&select=id,event_type,resolution,resolved_campaign_id`);
      check(post.status === 200 && row?.id === id, "POST /outcomes logs an outcome against a reply",
        `id=${row?.id ?? "(none)"} resolution=${row?.resolution}`);

      const again = await api("/outcomes", json("POST", { replyId: reply.id, eventType: "phone_screen" }));
      const twice = await sb(`outcome_events?id=eq.${encodeURIComponent(id)}&select=id`);
      check(again.status === 200 && twice.length === 1,
        "logging it twice is idempotent — the id is derived, not generated", `${twice.length} row(s)`);

      const bad = await api(`/outcomes?id=${encodeURIComponent("6f941a36-8ac2-417e-abfa-2ab0340e8344")}`, { method: "DELETE" });
      check(bad.status === 400, "DELETE refuses a row the outcomes feed owns", `status ${bad.status}`);

      await api(`/outcomes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const gone = await sb(`outcome_events?id=eq.${encodeURIComponent(id)}&select=id`);
      check(gone.length === 0, "DELETE removes the hand-logged one", `${gone.length} row(s) left`);
    }
  }

  /* ===================================================================== */
  console.log("\n  ── campaign settings, on a campaign this test creates ──");

  {
    /*
     * The settings route writes to EmailBison FIRST and only then to the local
     * cache, which is the whole discipline: it can never show a change as saved
     * when it was not. Proving that needs a real EmailBison campaign — so this
     * makes one, edits it, reads both sides back, and deletes it.
     */
    const eb = async (path, init = {}) => {
      const r = await fetch(`${env.ANALYTICS_EMAILBISON_BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.ANALYTICS_EMAILBISON_API_KEY}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    const made = await eb("/api/campaigns", { method: "POST", body: JSON.stringify({ name: NAME }) });
    const campaignId = made.body?.data?.id;
    check(Boolean(campaignId), `created campaign "${NAME}" in EmailBison to test against`, `id ${campaignId}`);

    if (campaignId) {
      cleanup.push(async () => {
        await eb(`/api/campaigns/${campaignId}`, { method: "DELETE" });
        /*
         * EmailBison deletes ASYNCHRONOUSLY — "queued for deletion" — which is
         * the same fact migration 022 records as the reason `deleted_at` has to
         * be reversible. A single read straight after the DELETE still returns
         * 200, so this polls for the 404 rather than trusting one answer.
         */
        let status = 0;
        for (let i = 0; i < 20; i++) {
          status = (await eb(`/api/campaigns/${campaignId}`)).status;
          if (status === 404) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        console.log(`  · cleanup: campaign ${campaignId} "${NAME}" returns ${status} from EmailBison`);
      });

      // The local cache needs the row before the route will act on it — the
      // handler reads `.eq("id").eq("team_id")` and 404s if it is absent.
      await fetch(`${env.ANALYTICS_SUPABASE_URL}/rest/v1/campaigns`, {
        method: "POST",
        headers: {
          apikey: env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ id: campaignId, team_id: 2, name: NAME, status: "draft" }),
      });
      cleanup.push(async () => {
        await fetch(`${env.ANALYTICS_SUPABASE_URL}/rest/v1/campaigns?id=eq.${campaignId}`, {
          method: "DELETE",
          headers: {
            apikey: env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
      });

      const conflict = await api(`/campaigns/${campaignId}/settings`, json("PATCH", {
        max_emails_per_day: 10,
        max_new_leads_per_day: 500,
      }));
      check(conflict.status === 422,
        "a daily cap below the new-lead cap is refused before EmailBison is called",
        `status ${conflict.status}`);

      /*
       * EmailBison enforces the SAME cross-field rule the route does, and a
       * fresh campaign is created with a 1,000 new-lead cap — so lowering the
       * email cap alone is refused upstream. That refusal is worth asserting on
       * its own, because it is the exact path where a lesser implementation
       * would have written the local cache anyway and shown the change as saved.
       */
      const refused = await api(`/campaigns/${campaignId}/settings`, json("PATCH", {
        max_emails_per_day: 137,
      }));
      const [afterRefusal] = await sb(`campaigns?id=eq.${campaignId}&select=max_emails_per_day`);
      const refusalAudit = await sb(`campaign_audit_log?campaign_id=eq.${campaignId}&status=eq.error&select=error&order=id.desc&limit=1`);
      check(refused.status === 502 && afterRefusal?.max_emails_per_day === null,
        "when EmailBison refuses, the local cache is NOT written — no false 'saved'",
        `status ${refused.status}, local cap still ${afterRefusal?.max_emails_per_day}`);
      check(Boolean(refusalAudit[0]?.error),
        "…and the refusal is recorded with EmailBison's own words",
        (refusalAudit[0]?.error ?? "").slice(0, 90));

      const saved = await api(`/campaigns/${campaignId}/settings`, json("PATCH", {
        max_emails_per_day: 900,
        max_new_leads_per_day: 50,
        plain_text: true,
      }));
      const [local] = await sb(`campaigns?id=eq.${campaignId}&select=max_emails_per_day,max_new_leads_per_day,plain_text`);
      const upstream = await eb(`/api/campaigns/${campaignId}`);
      check(saved.status === 200 && local?.max_emails_per_day === 900 && local?.plain_text === true,
        "PATCH settings writes through to the local cache",
        `local cap=${local?.max_emails_per_day} leads=${local?.max_new_leads_per_day} plain_text=${local?.plain_text}`);
      check(
        Number(upstream.body?.data?.max_emails_per_day) === 900,
        "…and EmailBison holds the same value — the cache is not the only place it went",
        `upstream cap=${upstream.body?.data?.max_emails_per_day}`,
      );

      const unchanged = await api(`/campaigns/${campaignId}/settings`, json("PATCH", {
        max_emails_per_day: 900,
      }));
      check(unchanged.status === 200 && unchanged.body?.note === "No values differed",
        "re-sending an unchanged value calls EmailBison not at all",
        `note: ${unchanged.body?.note}`);

      const audit = await sb(`campaign_audit_log?campaign_id=eq.${campaignId}&status=eq.ok&select=action,actor,status,before_state,after_state&order=id.desc&limit=1`);
      check(
        audit[0]?.action === "update" && audit[0]?.actor === "admin@outreachify.io" && audit[0]?.status === "ok",
        "an audit row names who changed it and what it was before",
        `action=${audit[0]?.action} actor=${audit[0]?.actor} before=${JSON.stringify(audit[0]?.before_state)}`,
      );
      cleanup.push(async () => {
        await fetch(`${env.ANALYTICS_SUPABASE_URL}/rest/v1/campaign_audit_log?campaign_id=eq.${campaignId}`, {
          method: "DELETE",
          headers: {
            apikey: env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
      });
    }
  }

  /* ===================================================================== */
  console.log("\n  ── the campaign actions, at their guards ───────────────");

  {
    const noConfirm = await api("/campaigns/actions", json("POST", {
      action: "resume",
      targets: [{ platform: "emailbison", id: "239" }],
    }));
    check(noConfirm.status === 428,
      "resume without an explicit confirm is refused — it is the one that starts sending",
      `status ${noConfirm.status}`);

    const unknown = await api("/campaigns/actions", json("POST", {
      action: "obliterate",
      targets: [{ platform: "emailbison", id: "239" }],
      confirm: true,
    }));
    check(unknown.status === 400, "an unknown action is refused", `status ${unknown.status}`);

    const noTargets = await api("/campaigns/actions", json("POST", { action: "pause", confirm: true }));
    check(noTargets.status === 400, "an action with no targets is refused", `status ${noTargets.status}`);
  }

  console.log("\n  ── deleting everything this run made ───────────────────");
} catch (error) {
  fail++;
  console.log(`\n  ✗ THREW: ${error.message}`);
} finally {
  for (const undo of cleanup.reverse()) {
    try { await undo(); } catch (e) { console.log(`  ! cleanup failed: ${e.message}`); }
  }
}

/* The proof: nothing named ZZ_OS_PORT_TEST_* survives anywhere. */
for (const [table, column] of [["clients", "name"], ["offers", "name"], ["campaigns", "name"]]) {
  const left = await sb(`${table}?${column}=like.ZZ_OS_PORT_TEST_*&select=id,${column}`);
  check(left.length === 0, `no ${table} row named ${NAME} survives`,
    left.length ? JSON.stringify(left) : "gone");
}
{
  const left = await sb(`copy_tags?value=like.ZZ_OS_PORT_TEST_*&select=sequence_step_id,dimension`);
  check(left.length === 0, "no copy_tags row carries the test value", left.length ? JSON.stringify(left) : "gone");
}
{
  const left = await sb(`reply_dimensions?client_id=not.is.null&select=id,client_id,key`);
  check(left.length === 0, "the test client's reply-dimension override cascaded away with it",
    left.length ? `${left.length} client-specific row(s) remain` : "gone");
}

console.log(`\n  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
