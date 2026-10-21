/*
 * The relay's rules, without a database: settings and their defaults, which
 * brokerage a campaign belongs to, the checks, the recipients, the wording.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brokerageFromJson,
  DEFAULT_BROKERAGE,
  DEFAULT_GLOBAL,
  deliveryMode,
  effectiveCap,
  effectiveMode,
  globalFromRow,
  globalToRow,
  parseBrokeragePatch,
  parseGlobalPatch,
  pipelineEntryFrom,
  RelaySettingsError,
} from "./settings.ts";
import { DEFAULT_FROM_ADDRESS, fromAddress, isRelayAddress, liveSendAllowed, messageStream, sweepSwitchedOff } from "./gate.ts";
import { campaignKey, osClientForPortal, portalsOfClient, resolveBrokerage, type World } from "./resolve.ts";
import {
  dncDomain,
  dncHit,
  hasIntroductionLabel,
  isActiveStatus,
  isExcludedBrokerage,
  isStaleReply,
  isTriggerLabel,
  looksAutomatic,
  looksLikeOptOut,
  ownText,
  pickAgentReply,
  planRecipients,
  replyToOf,
  REPLY_MAX_AGE_MS,
  stopLabel,
  trimReplyHeader,
  type MessageFacts,
} from "./rules.ts";
import { recipientsPhrase, recordView, relayLine, REASON_TEXT } from "./wording.ts";
import type { IntroMacroClient } from "../inbox/intro-macro.ts";

/* ------------------------------------------------------------------ settings */

test("defaults: off, practice, one click, nothing forwarded, not an introduction", () => {
  const g = globalFromRow(null);
  assert.equal(g.present, false);
  assert.equal(g.enabled, false);
  assert.equal(g.practiceMode, true);
  assert.equal(g.mode, "one_click");
  assert.equal(g.forwardLaterReplies, false);
  assert.equal(g.countsAsIntroduction, false);
  assert.equal(g.hourlyCap, 5);
  assert.deepEqual(brokerageFromJson(undefined), DEFAULT_BROKERAGE);
  assert.equal(DEFAULT_BROKERAGE.enabled, false);
  assert.equal(DEFAULT_BROKERAGE.recipients, "intro_contacts");
});

test("practice is anything but an explicit false; a brokerage is on only when it says true", () => {
  assert.equal(globalFromRow({ practice_mode: null }).practiceMode, true);
  assert.equal(globalFromRow({ practice_mode: "false" }).practiceMode, true);
  assert.equal(globalFromRow({ practice_mode: false }).practiceMode, false);
  assert.equal(brokerageFromJson({ enabled: "true" }).enabled, false);
  assert.equal(brokerageFromJson({ enabled: 1 }).enabled, false);
  assert.equal(brokerageFromJson({ enabled: true }).enabled, true);
  // An address mode with no valid address falls back to the introduction contacts.
  assert.equal(brokerageFromJson({ recipients: "address", address: "not-an-email" }).recipients, "intro_contacts");
  assert.equal(brokerageFromJson({ recipients: "address", address: "Leads@Brokerage.com" }).address, "leads@brokerage.com");
});

test("live needs every lock open: env, global switch, practice off, brokerage switch", () => {
  const on = { ...DEFAULT_GLOBAL, enabled: true, practiceMode: false };
  const b = { ...DEFAULT_BROKERAGE, enabled: true };
  assert.equal(deliveryMode(on, b, true), "live");
  assert.equal(deliveryMode(on, b, false), "practice", "env switch off");
  assert.equal(deliveryMode({ ...on, enabled: false }, b, true), "practice", "global switch off");
  assert.equal(deliveryMode({ ...on, practiceMode: true }, b, true), "practice", "practice mode");
  assert.equal(deliveryMode(on, { ...b, enabled: false }, true), "practice", "brokerage switch off");
  assert.equal(deliveryMode(DEFAULT_GLOBAL, DEFAULT_BROKERAGE, true), "practice", "the defaults");
});

test("mode and cap: the brokerage's override, else the global one", () => {
  assert.equal(effectiveMode(DEFAULT_GLOBAL, DEFAULT_BROKERAGE), "one_click");
  assert.equal(effectiveMode(DEFAULT_GLOBAL, { ...DEFAULT_BROKERAGE, mode: "automatic" }), "automatic");
  assert.equal(effectiveCap({ ...DEFAULT_GLOBAL, hourlyCap: 7 }, DEFAULT_BROKERAGE), 7);
  assert.equal(effectiveCap(DEFAULT_GLOBAL, { ...DEFAULT_BROKERAGE, hourlyCap: 2 }), 2);
  assert.equal(brokerageFromJson({ hourly_cap: 500 }).hourlyCap, 100, "clamped");
});

test("pipeline entry: today's behaviour unless the client says interested", () => {
  assert.equal(pipelineEntryFrom(undefined), "introduction");
  assert.equal(pipelineEntryFrom("Interested"), "introduction");
  assert.equal(pipelineEntryFrom("interested"), "interested");
});

test("global patch: validated; switching on stamps the go-live time, staying on keeps it", () => {
  assert.throws(() => parseGlobalPatch({ enabled: "yes" }), RelaySettingsError);
  assert.throws(() => parseGlobalPatch({ mode: "instant" }), RelaySettingsError);
  assert.throws(() => parseGlobalPatch({ hourlyCap: 0 }), RelaySettingsError);
  assert.deepEqual(parseGlobalPatch({ enabled: true, unknown: 1 }), { enabled: true });
  const now = new Date("2026-10-20T12:00:00.000Z");
  const on = globalToRow("ws", globalFromRow(null), { enabled: true }, "amy@x.test", now);
  assert.equal(on.enabled_since, now.toISOString());
  assert.equal(on.practice_mode, true, "switching on does not leave practice");
  const later = globalToRow("ws", globalFromRow(on), { hourlyCap: 3 }, "amy@x.test", new Date("2026-10-21T00:00:00.000Z"));
  assert.equal(later.enabled_since, now.toISOString());
  const offOn = globalToRow("ws", globalFromRow({ ...on, enabled: false }), { enabled: true }, null, new Date("2026-10-22T00:00:00.000Z"));
  assert.equal(offOn.enabled_since, "2026-10-22T00:00:00.000Z", "off then on: nothing from while it was off");
});

test("brokerage patch: address mode needs an address; pipeline entry only two values", () => {
  assert.throws(() => parseBrokeragePatch({ recipients: "address" }, DEFAULT_BROKERAGE), /address/);
  assert.throws(() => parseBrokeragePatch({ address: "nope" }, DEFAULT_BROKERAGE), /email/);
  assert.throws(() => parseBrokeragePatch({ pipelineEntry: "hired" }, DEFAULT_BROKERAGE), RelaySettingsError);
  const r = parseBrokeragePatch({ enabled: true, recipients: "address", address: "Team@B.com", hourlyCap: "", pipelineEntry: "interested" }, DEFAULT_BROKERAGE);
  assert.deepEqual(r.settings, { enabled: true, mode: null, recipients: "address", address: "team@b.com", hourlyCap: null });
  assert.equal(r.pipelineEntry, "interested");
});

test("gate: live send only on exactly '1'; From only on leads.brokerstaffer.com", () => {
  assert.equal(liveSendAllowed({}), false);
  assert.equal(liveSendAllowed({ OS_BROKERAGE_RELAY_LIVE_SEND: "true" }), false);
  assert.equal(liveSendAllowed({ OS_BROKERAGE_RELAY_LIVE_SEND: " 1 " }), true);
  assert.equal(sweepSwitchedOff({ OS_BROKERAGE_RELAY: "0" }), true);
  assert.equal(sweepSwitchedOff({}), false);
  assert.equal(fromAddress({}), DEFAULT_FROM_ADDRESS);
  assert.equal(fromAddress({ OS_BROKERAGE_RELAY_FROM: "nicole.c@brokerstaffer.com" }), DEFAULT_FROM_ADDRESS, "never the normal mail");
  assert.equal(fromAddress({ OS_BROKERAGE_RELAY_FROM: "Intros@Leads.BrokerStaffer.com" }), "intros@leads.brokerstaffer.com");
  assert.equal(isRelayAddress("x@evil-leads.brokerstaffer.com.attacker.test"), false);
});

test("gate: From has exactly one @, on leads.brokerstaffer.com itself (review fix)", () => {
  // Used to pass: it began like an address and ended in "@leads.brokerstaffer.com".
  assert.equal(isRelayAddress("x@attacker.test@leads.brokerstaffer.com"), false);
  assert.equal(fromAddress({ OS_BROKERAGE_RELAY_FROM: "x@attacker.test@leads.brokerstaffer.com" }), DEFAULT_FROM_ADDRESS);
  assert.equal(isRelayAddress("agents@sub.leads.brokerstaffer.com"), false);
  assert.equal(isRelayAddress("agents@leadsxbrokerstaffer.com"), false, "the dot is literal");
  assert.equal(isRelayAddress(" Agents@Leads.BrokerStaffer.com "), true);
});

test("gate: the transactional stream always — the broadcast stream is refused (review fix)", () => {
  assert.equal(messageStream({}), "outbound");
  assert.equal(messageStream({ POSTMARK_MESSAGE_STREAM: "broadcast" }), "outbound");
  assert.equal(messageStream({ POSTMARK_MESSAGE_STREAM: "Broadcasts" }), "outbound");
  assert.equal(messageStream({ POSTMARK_MESSAGE_STREAM: "out bound" }), "outbound", "not a stream id");
  assert.equal(messageStream({ POSTMARK_MESSAGE_STREAM: "brokerage-relay" }), "brokerage-relay");
});

/* ------------------------------------------------------------------ resolve */

const P = {
  jeff: { id: "p-jeff", name: "Jeff Cook Real Estate", slug: "jeff-cook-real-estate", aliases: [] },
  boston: { id: "p-bos", name: "Properties & Estates Boston", slug: "pe-boston", aliases: ["Properties & Estates"] },
  florida: { id: "p-fl", name: "Properties & Estates Florida", slug: "pe-florida", aliases: [] },
  wagner: { id: "p-wag", name: "Wagner Realty", slug: "wagner-realty", aliases: [] },
  wagnerGroup: { id: "p-wag2", name: "Wagner Group", slug: "wagner-group", aliases: [] },
  unknown: { id: "p-unk", name: "Unknown", slug: "unknown", aliases: [] },
};
const world: World = {
  portals: Object.values(P),
  clients: [
    { id: "c-jeff", name: "Jeff Cook Real Estate", aliases: [], miClientId: "p-jeff" },
    { id: "c-pe", name: "Properties & Estates", aliases: ["Properties & Estates Florida"], miClientId: "p-bos" },
    { id: "c-wag", name: "Wagner Realty", aliases: [], miClientId: "p-wag" },
    { id: "c-wag2", name: "Wagner Group", aliases: [], miClientId: "p-wag2" },
  ],
  campaignPortals: [{ platform: "emailbison", campaignId: "77", osClientId: "c-pe", miClientId: "p-fl" }],
  teamCampaigns: [],
};

test("the brokerage comes from the campaign name, the way the inbox files it", () => {
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "1", campaignName: "Jeff Cook Real Estate + Charleston, SC + ZF NS1", threadPortalId: "p-jeff" }, world);
  assert.deepEqual(r, { ok: true, osClientId: "c-jeff", portalId: "p-jeff", source: "campaign_name" });
});

test("a campaign → portal choice (0025) wins over the name", () => {
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "77", campaignName: "Properties & Estates + Nicole + Florida", threadPortalId: "p-fl" }, world);
  assert.deepEqual(r, { ok: true, osClientId: "c-pe", portalId: "p-fl", source: "campaign_portal" });
});

test("never from the sender inbox: a campaign that names no brokerage is held, whoever sent it", () => {
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "9", campaignName: "Template Zillow Flex", threadPortalId: "p-unk" }, world);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "unknown_campaign");
  assert.equal(!r.ok && r.outcome, "hold");
});

test("a tie between two brokerages is held, not guessed", () => {
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "5", campaignName: "Wagner - Miami agents", threadPortalId: null }, {
    ...world,
    portals: [
      { id: "a", name: "Wagner Miami", aliases: [] },
      { id: "b", name: "Wagner Miami", aliases: [] },
    ],
    clients: [
      { id: "ca", name: "Wagner Miami", aliases: [], miClientId: "a" },
      { id: "cb", name: "Wagner Miami Two", aliases: [], miClientId: "b" },
    ],
  });
  assert.equal(!r.ok && r.reason, "ambiguous_campaign");
});

test("campaign and conversation disagree → held for the team", () => {
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "1", campaignName: "Jeff Cook Real Estate + Columbia", threadPortalId: "p-wag" }, world);
  assert.equal(!r.ok && r.reason, "campaign_conflict");
  assert.equal(!r.ok && r.detail, "Wagner Realty");
  // Filed under Unknown disagrees with nobody.
  const ok = resolveBrokerage({ platform: "emailbison", campaignId: "1", campaignName: "Jeff Cook Real Estate + Columbia", threadPortalId: "p-unk" }, world);
  assert.equal(ok.ok, true);
});

test("the team's answer wins, and 'not a brokerage campaign' skips", () => {
  const w = { ...world, teamCampaigns: [{ platform: "emailbison", campaignId: "9", osClientId: "c-wag", ignored: false }, { platform: "instantly", campaignId: "u-1", osClientId: null, ignored: true }] };
  const r = resolveBrokerage({ platform: "emailbison", campaignId: "9", campaignName: "Template Zillow Flex", threadPortalId: "p-unk" }, w);
  assert.deepEqual(r, { ok: true, osClientId: "c-wag", portalId: "p-wag", source: "team" });
  const s = resolveBrokerage({ platform: "instantly", campaignId: "u-1", campaignName: "Not Interested - All Clients", threadPortalId: null }, w);
  assert.equal(!s.ok && s.reason, "ignored_campaign");
  assert.equal(!s.ok && s.outcome, "skip");
});

test("the team's answer settles a conflict — either brokerage — instead of being held against the filing again (21 Oct review)", () => {
  const conflict = { platform: "emailbison", campaignId: "1", campaignName: "Jeff Cook Real Estate + Columbia", threadPortalId: "p-wag" };
  const team = (osClientId: string) => ({ ...world, teamCampaigns: [{ platform: "emailbison", campaignId: "1", osClientId, ignored: false }] });
  assert.deepEqual(resolveBrokerage(conflict, team("c-jeff")), { ok: true, osClientId: "c-jeff", portalId: "p-jeff", source: "team" }, "the campaign's brokerage");
  assert.deepEqual(resolveBrokerage(conflict, team("c-wag")), { ok: true, osClientId: "c-wag", portalId: "p-wag", source: "team" }, "the filed one");
  // Without a team answer, still held.
  assert.equal((resolveBrokerage(conflict, world) as { reason?: string }).reason, "campaign_conflict");
});

test("portals of a client: its link, its campaign choices, and its exact names", () => {
  assert.deepEqual(portalsOfClient("c-pe", world).sort(), ["p-bos", "p-fl"]);
  assert.equal(osClientForPortal("p-fl", world), "c-pe");
  assert.equal(osClientForPortal("p-unk", world), null);
  assert.deepEqual(campaignKey({ platform: null, campaignId: null, campaignName: "Some Campaign" }), { platform: "unknown", campaignId: "name:some campaign" });
  assert.equal(campaignKey({ platform: "emailbison", campaignId: null, campaignName: null }), null);
});

/* ------------------------------------------------------------------ checks */

const msg = (over: Partial<MessageFacts>): MessageFacts => ({
  id: "m",
  direction: "inbound",
  sender: "jordan@coastal.test",
  senderName: "Jordan Ellis",
  subject: "Re: Quick question, Jordan",
  bodyText: "Sure, happy to chat.",
  bodyHtml: null,
  sentAt: "2026-10-15T14:00:00.000Z",
  ...over,
});
const lead = { id: "l1", fullName: "Jordan Ellis", email: "jordan@coastal.test" };

test("labels: Interested and Meetings Booked trigger; Not Interested never does", () => {
  assert.equal(isTriggerLabel("Interested"), true);
  assert.equal(isTriggerLabel(" meetings booked "), true);
  assert.equal(isTriggerLabel("Not Interested"), false);
  assert.equal(isTriggerLabel("Introduction"), false);
  assert.equal(stopLabel(["Interested", "Unsubscribe"]), "Unsubscribe");
  assert.equal(stopLabel(["Interested", "OOO Sequence"]), "OOO Sequence");
  assert.equal(stopLabel(["Interested"]), null);
  assert.equal(hasIntroductionLabel(["Interested", "Introduction"]), true);
});

test("out-of-office and automatic replies are recognised; a real reply is not", () => {
  assert.equal(looksAutomatic("Automatic reply: Quick question", "Thanks", "jordan@coastal.test"), true);
  assert.equal(looksAutomatic("Re: Quick question", "I am currently out of the office until Monday.", "jordan@coastal.test"), true);
  assert.equal(looksAutomatic("Re: Quick question", "Sure", "mailer-daemon@googlemail.com"), true);
  assert.equal(looksAutomatic("Re: Quick question", "Sure, happy to chat. Mornings work best.", "jordan@coastal.test"), false);
  assert.equal(looksLikeOptOut("Please remove me from your list"), true);
  assert.equal(looksLikeOptOut("Sure, happy to chat."), false);
});

test("curly apostrophes and the missed out-of-office / opt-out phrases are recognised — real replies still are not (21 Oct review)", () => {
  const auto = (text: string, subject = "Re: Quick question") => looksAutomatic(subject, text, "jordan@coastal.test");
  for (const t of [
    "I’m out of the office until Monday.",
    "I’m currently away from the office with limited access.",
    "I am currently on vacation and will return on the 28th.",
    "Thank you for your email. I am away from the office until Monday.",
    "Thanks for your message — I’m out of the office this week.",
    "I'm away until 3 November with no access to email.",
  ]) assert.equal(auto(t), true, t);
  assert.equal(auto("Thanks", "Out of Office: Quick question"), true);
  for (const t of [
    "I'm travelling this week but yes, call me Thursday.",
    "I’m away until Monday but yes, happy to chat after that.",
    "I'm on vacation this week but definitely interested — email me next week.",
    "Thanks for your email! Yes, I'd like to hear more.",
  ]) assert.equal(auto(t), false, t);

  for (const t of ["Please don’t contact me again.", "Stop emailing me.", "Do not email me.", "Leave me alone", "No more emails please"]) assert.equal(looksLikeOptOut(t), true, t);
  for (const t of ["Sure, happy to chat.", "Don't email my work address — use jordan@gmail.com", "Please stop by the office Tuesday."]) assert.equal(looksLikeOptOut(t), false, t);
});

test("an out-of-office (or an empty message) after the real 'yes' does not hide it — the newest one a person wrote is handed over (21 Oct review)", () => {
  const yes = msg({ id: "yes", bodyText: "Yes, interested — call me.", sentAt: "2026-10-15T14:00:00.000Z" });
  const ooo = msg({ id: "ooo", subject: "Automatic reply: Quick question", bodyText: "I am out of the office until Monday.", sentAt: "2026-10-15T14:30:00.000Z" });
  const empty = msg({ id: "empty", bodyText: "", bodyHtml: null, sentAt: "2026-10-15T14:40:00.000Z" });
  assert.equal(pickAgentReply([yes, ooo, empty], lead, "2026-10-15T15:00:00.000Z")?.id, "yes");
  // Every one automatic: the newest, so it is skipped as automatic rather than guessed.
  assert.equal(pickAgentReply([ooo], lead, "2026-10-15T15:00:00.000Z")?.id, "ooo");
  // A later real reply after the label is still not the marked one.
  const later = msg({ id: "later", bodyText: "Also, Fridays are best.", sentAt: "2026-10-15T18:00:00.000Z" });
  assert.equal(pickAgentReply([yes, ooo, later], lead, "2026-10-15T15:00:00.000Z")?.id, "yes");
});

test("the reply handed over is the agent's own words — the quoted email under it is ours", () => {
  const text = ownText(msg({ bodyText: "Sure, happy to chat.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Nicole Collins <n@b.test> wrote:\n> Hi Jordan" }));
  assert.equal(text, "Sure, happy to chat.");
  const html = ownText(msg({ bodyText: null, bodyHtml: "<p>Yes &amp; thanks</p><div class=\"gmail_quote\">On Mon … wrote:<blockquote>Hi</blockquote></div>" }));
  assert.equal(html, "Yes & thanks");
});

test("pick the agent's reply at the label — not the client's staff, not a later one", () => {
  const messages = [
    msg({ id: "out", direction: "outbound", sender: "nicole@b.test", sentAt: "2026-10-15T10:00:00.000Z" }),
    msg({ id: "r1", sentAt: "2026-10-15T14:00:00.000Z" }),
    msg({ id: "staff", sender: "angela@jeffcook.test", senderName: "Angela Oakes", sentAt: "2026-10-15T15:00:00.000Z" }),
    msg({ id: "r2", sentAt: "2026-10-15T18:00:00.000Z" }),
  ];
  assert.equal(pickAgentReply(messages, lead, "2026-10-15T14:05:00.000Z")?.id, "r1");
  assert.equal(pickAgentReply(messages, lead, null)?.id, "r2");
  // Replied from another address under the same name: still the agent's.
  const other = [msg({ id: "alt", sender: "jordan.ellis@gmail.test", senderName: "Jordan Ellis" })];
  assert.equal(pickAgentReply(other, lead, null)?.id, "alt");
  assert.equal(replyToOf(lead, other[0]), "jordan.ellis@gmail.test", "Reply-To is where they wrote from");
  assert.equal(pickAgentReply([msg({ id: "x", sender: "angela@jeffcook.test", senderName: "Angela Oakes" })], lead, null), null);
});

test("DNC: by address, by company domain (sub-domains too), by full name on name-only entries", () => {
  const agent = { emails: ["jordan@mail.coastal.test"], name: "Jordan Ellis" };
  assert.deepEqual(dncHit([{ kind: "agent", name: "J", email: "JORDAN@mail.coastal.test", domain: null }], agent), { by: "email", entry: "jordan@mail.coastal.test" });
  assert.deepEqual(dncHit([{ kind: "company", name: "Coastal", email: null, domain: "coastal.test" }], agent), { by: "domain", entry: "coastal.test" });
  assert.deepEqual(dncHit([{ kind: "agent", name: "Jordan A. Ellis", email: null, domain: null }], agent), { by: "name", entry: "Jordan A. Ellis" });
  // A name entry that carries a DIFFERENT address is not a name match — it is another person's address.
  // An entry with an address still stops the same person writing from another one (21 Oct review).
  assert.deepEqual(dncHit([{ kind: "agent", name: "Jordan Ellis", email: "jordan@old-brokerage.test", domain: null }], agent), { by: "name", entry: "Jordan Ellis" });
  assert.equal(dncHit([{ kind: "company", name: "Jordan Ellis", email: "x@coastal-other.test", domain: null }], agent), null, "a company entry never matches a person's name");
  assert.equal(dncHit([{ kind: "agent", name: "Jordan Smith", email: null, domain: null }], agent), null);
});

const jeffCook: IntroMacroClient = {
  name: "Jeff Cook Real Estate",
  brokerage: "Jeff Cook Real Estate",
  contactName: "Angela Oakes",
  contactRole: "Recruiter",
  contactEmail: "angela@jeffcook.test",
  contactTerritories: ["Charlotte"],
  extraContacts: [
    { name: "Lance Overstreet", role: "Broker", email: "lance@jeffcook.test", territories: ["Charleston", "Summerville"] },
    { name: "Stan Taylor", role: "Broker", email: "stan@jeffcook.test", territories: ["Charleston", "Summerville"] },
    { name: "Alma Nowatzke", role: "Recruiter", email: "alma@jeffcook.test", territories: ["Myrtle Beach", "Greenville"] },
    { name: "No Address", role: "Owner", email: null, territories: ["Charleston"] },
  ],
};

test("recipients: the introduction contacts for the campaign's territory, as the Introduce button routes them", () => {
  const p = planRecipients(DEFAULT_BROKERAGE, jeffCook, "Jeff Cook Real Estate + Charleston, SC + ZF NS1", ["jordan@coastal.test"]);
  assert.deepEqual(p.recipients.map((r) => r.email), ["lance@jeffcook.test", "stan@jeffcook.test"]);
  assert.equal(p.via, "intro_contacts");
  assert.deepEqual(p.route?.matched, ["Charleston"]);
  // No territory in the campaign: everyone with an address.
  const all = planRecipients(DEFAULT_BROKERAGE, jeffCook, "Interested ZF - With Phone Number", []);
  assert.equal(all.recipients.length, 4);
  // One address of the brokerage's own, when chosen.
  const one = planRecipients({ ...DEFAULT_BROKERAGE, recipients: "address", address: "leads@jeffcook.test" }, jeffCook, "Jeff Cook + Charleston", []);
  assert.deepEqual(one.recipients, [{ name: null, email: "leads@jeffcook.test" }]);
  // The agent never receives their own reply.
  const self = planRecipients(DEFAULT_BROKERAGE, { ...jeffCook, contactTerritories: [], extraContacts: [] , contactEmail: "jordan@coastal.test" }, "x", ["jordan@coastal.test"]);
  assert.equal(self.recipients.length, 0);
});

test("only active brokerages; never Demo Portal", () => {
  assert.equal(isActiveStatus("active"), true);
  for (const s of ["paused", "churned", "onboarding", null]) assert.equal(isActiveStatus(s), false, String(s));
  assert.equal(isExcludedBrokerage("Demo Portal"), true);
  assert.equal(isExcludedBrokerage("Jeff Cook Real Estate", "demo portal"), true);
  assert.equal(isExcludedBrokerage("Jeff Cook Real Estate"), false);
});

/* ------------------------------------------------------------------ wording */

const view = (over: Record<string, unknown>) =>
  recordView({ id: "r", kind: "handoff", status: "sent", recipients: [{ name: "Angela Oakes", email: "angela@x.test" }], practice: false, ...over });

test("the record on the conversation reads like the plan: 'Sent to Angela at 10:42'", () => {
  assert.equal(relayLine(view({ sent_at: "2026-10-15T14:42:00.000Z" })).text, "Sent to Angela at 10:42 AM");
  assert.match(relayLine(view({ status: "practice", decided_at: "2026-10-15T14:42:00.000Z", practice: true })).text, /^Practice — would have gone to Angela at 10:42 AM\. Nothing was sent\.$/);
  assert.match(relayLine(view({ status: "held", reason: "unknown_campaign" })).text, /waiting for the team/);
  assert.match(relayLine(view({ status: "skipped", reason: "dnc", brokerage_name: "Jeff Cook", detail: "by name" })).text, /Not handed to Jeff Cook — .*Do Not Contact.*\(by name\)/);
  assert.match(relayLine(view({ status: "ready", brokerage_name: "Jeff Cook", practice: true })).text, /practice — nothing will be sent/);
  for (const reason of ["unknown_campaign", "hourly_cap", "dnc", "already_delivered", "auto_reply", "brokerage_not_active"]) {
    assert.ok(REASON_TEXT[reason], reason);
  }
});

/* ------------------------------------------------------------------ review fixes (17 Oct) */

test("quote headers a short reply leaves behind are trimmed — Gmail's two-line one, Outlook's From:/Sent: block (review fix)", () => {
  const gmail = "Sure.\n\nOn Mon, Oct 5, 2026 at 10:00 AM Nicole Collins <\nnicole.c@brokerstaffer.com> wrote:\n\n> Hi Jordan";
  assert.equal(ownText(msg({ bodyText: gmail })), "Sure.");
  const outlook = "Yes!\n\n________________________________\nFrom: Nicole Collins <nicole.c@brokerstaffer.com>\nSent: Monday, October 5, 2026 10:00 AM\nTo: Jordan\nSubject: Quick question";
  assert.equal(ownText(msg({ bodyText: outlook })), "Yes!");
  assert.equal(trimReplyHeader("Call me.\nFrom: N <n@b.test>\nDate: Mon\nSubject: Q"), "Call me.");
  // The agent's own words are left alone, even when they mention "from" or "on".
  const own = "On Monday I'm free from 2pm.\nFrom: my cell, (843) 555-0142";
  assert.equal(trimReplyHeader(own), own);
});

test("a reply more than 14 days older than its label is stale; no date cannot show it is recent (review fix)", () => {
  const label = "2026-10-15T15:00:00.000Z";
  assert.equal(isStaleReply("2026-10-14T15:00:00.000Z", label), false);
  assert.equal(isStaleReply("2026-10-01T14:59:00.000Z", label), true);
  assert.equal(isStaleReply("2026-10-01T15:00:00.000Z", label), false, "exactly 14 days is still fine");
  assert.equal(isStaleReply(null, label), true);
  assert.equal(isStaleReply("2026-10-16T00:00:00.000Z", label), false, "a reply after the label (the grace) is not stale");
  assert.equal(REPLY_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("DNC domains read the DNC tool's way; only company entries block a domain; names never match a company (review fix)", () => {
  assert.equal(dncDomain("https://www.KW.com/team"), "kw.com");
  assert.equal(dncDomain("@coastal.test"), "coastal.test");
  assert.equal(dncDomain("not a domain"), null);
  const agent = { emails: ["jordan@coastal.test"], name: "Jordan Ellis" };
  assert.deepEqual(dncHit([{ kind: "company", name: "Coastal", email: null, domain: "www.coastal.test" }], agent), { by: "domain", entry: "coastal.test" });
  assert.equal(dncHit([{ kind: "agent", name: "Pat", email: "pat@coastal.test", domain: "coastal.test" }], agent), null, "an agent entry blocks an address, not a domain");
  assert.equal(dncHit([{ kind: "agent", name: "Pat", email: "pat@gmail.test", domain: "gmail.test" }], { emails: ["jordan@gmail.test"], name: "Jordan Ellis" }), null);
  assert.equal(dncHit([{ kind: "agent", name: "Pat Other", email: null, domain: "gmail.test" }], { emails: ["jordan@gmail.test"], name: "Jordan Ellis" }), null, "an agent entry with only a domain still blocks no domain");
  assert.deepEqual(dncHit([{ kind: null, name: "Coastal", email: null, domain: "coastal.test" }], agent), { by: "domain", entry: "coastal.test" }, "no kind, a domain and no address: a company");
  assert.equal(dncHit([{ kind: "company", name: "Jordan Ellis", email: null, domain: "other.test" }], agent), null, "a company called after a person is not that person");
  assert.deepEqual(dncHit([{ kind: "agent", name: "JORDAN ELLIS JR.", email: "", domain: null }], agent), { by: "name", entry: "JORDAN ELLIS JR." });
});

test("automatic replies: the added out-of-office phrases match; a real reply that mentions travel does not (review fix)", () => {
  for (const t of [
    "This is an automated response. I will reply shortly.",
    "I have limited access to email this week.",
    "I will respond to your message upon my return on Monday.",
    "I am on maternity leave until January.",
  ]) assert.equal(looksAutomatic("Re: Quick question", t, "jordan@coastal.test"), true, t);
  for (const t of ["I'm travelling this week but yes, call me Monday.", "Sure — back from vacation, happy to chat.", "Leave me your number and I'll call."]) {
    assert.equal(looksAutomatic("Re: Quick question", t, "jordan@coastal.test"), false, t);
  }
});

test("the conversation line carries the date when it was not today, and a stuck send says so (review fix)", () => {
  const today = "2026-10-17T15:00:00.000Z";
  assert.equal(relayLine(view({ sent_at: "2026-10-14T14:42:00.000Z" }), today).text, "Sent to Angela at Oct 14, 10:42 AM");
  assert.equal(relayLine(view({ sent_at: "2026-10-17T14:42:00.000Z" }), today).text, "Sent to Angela at 10:42 AM");
  assert.equal(relayLine(view({ status: "sending", decided_at: "2026-10-17T14:58:00.000Z" }), today).text, "Sending to Angela…");
  const stuck = relayLine(view({ status: "sending", decided_at: "2026-10-17T14:00:00.000Z" }), today);
  assert.equal(stuck.tone, "problem");
  assert.match(stuck.text, /no answer was recorded.*never sent again by itself/);
  assert.match(relayLine(view({ status: "failed", reason: "send_unknown" })).text, /may have been sent/);
  assert.match(relayLine(view({ status: "failed", reason: "send_partial", error: "Found inactive addresses: a@x.test." })).text, /^Not confirmed — .*may have received it.*a@x\.test/);
  assert.match(relayLine(view({ status: "bounced", error: "HardBounce — a@x.test" })).text, /^Bounced — HardBounce/);
  assert.match(relayLine(view({ status: "bounced", error: "HardBounce — a@x.test", recipients: [{ name: "A", email: "a@x.test" }, { name: "B", email: "b@x.test" }] })).text, /^Did not reach everyone/);
  for (const reason of ["stale_reply", "send_failed", "send_unknown", "send_partial"]) assert.ok(REASON_TEXT[reason], reason);
});

test("recipients read as first names", () => {
  const r = (n: string) => ({ name: n, email: `${n.toLowerCase()}@x.test` });
  assert.equal(recipientsPhrase([r("Angela Oakes")]), "Angela");
  assert.equal(recipientsPhrase([r("Lance Overstreet"), r("Stan Taylor")]), "Lance and Stan");
  assert.equal(recipientsPhrase([r("A"), r("B"), r("C"), r("D")]), "A and 3 others");
  assert.equal(recipientsPhrase([{ name: null, email: "leads@x.test" }]), "leads@x.test");
});
