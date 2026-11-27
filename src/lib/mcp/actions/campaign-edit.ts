import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { areaInChanged, copyModel, htmlToText, inputUsesArea, planCopySave, type SaveInput, type StepWrite } from "@/lib/crm-preview/campaign-copy";
import { realDeps, stateOf } from "@/lib/crm-preview/campaigns";
import { clientFieldsProblem, fillSteps, usesClientFields } from "@/lib/tools/analytics/campaigns/client-fields.ts";
import { clientFieldValuesForCampaign } from "@/lib/tools/analytics/campaigns/client-fields-load";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";
import { resolveEbCampaign } from "./campaign-one.ts";

/*
 * Change the wording of ONE email of one campaign through Claude (27 Nov, the Campaigns group). Its subject and/or text,
 * the main email or one of its A/B versions; never adds, removes, reorders or re-times anything.
 *
 * It runs the planner the client portal's Campaigns editor has used live since 23 Nov (crm-preview/campaign-copy.ts
 * planCopySave): plain text in, EmailBison's HTML out, only the changed step written (each update names its id, and
 * EmailBison changes only the steps listed), against a fingerprint of the sequence as read, so an edit made meanwhile is
 * never written over. Its copy rules hold here too: at most 125 words, a 60-character subject, no links, and only
 * fields this campaign can fill. {CLIENT_AREA} and {CLIENT_ALIAS} are filled from the campaign's client before anything
 * is written, as the OS's sequence editor does: EmailBison only ever holds the finished text. Written to the campaign's
 * history as "<email> via Claude". Anything else (new emails, waits, longer copy) stays on the OS's sequence editor.
 */

const VERSION_LETTER = (i: number) => String.fromCharCode(65 + i);
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

type Args = { campaign: string; email: number; version: number; subject?: string; text?: string };
type Bind = { id: number; name: string; sequenceId: number; fingerprint: string; writes: Array<Omit<StepWrite, "orderOnly">> };

export const campaignEditCopy: ActionSpec<Args, Bind> = {
  name: "campaign_edit_copy",
  title: "Change one email's wording",
  description:
    "Change the subject and/or text of ONE email in ONE EmailBison campaign (email 1 is the first in its sequence; " +
    "version 2 is its first A/B version). Plain text in. The client portal editor's rules hold: at most 125 words, a " +
    "60-character subject, no links, only fields the campaign can fill ({FIRST_NAME}, {SENDER_FIRST_NAME}, " +
    "{SENDER_FULL_NAME}, {CLIENT_AREA}, and any it already uses). Read the current wording first with campaign_copy. " +
    "It never adds, removes, reorders or re-times emails.",
  inputSchema: {
    type: "object",
    properties: {
      campaign: { type: "string", description: "The campaign's name or number." },
      email: { type: "integer", minimum: 1, description: "Which email of its sequence, from 1." },
      version: { type: "integer", minimum: 1, description: "1 (default) the main email; 2 its first A/B version, and so on." },
      subject: { type: "string", description: "The new subject (leave out to keep it)." },
      text: { type: "string", description: "The new text, plain (leave out to keep it)." },
    },
    required: ["campaign", "email"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  needs: (grantsForRequest("/api/tools/analytics/campaigns/1/sequence", "PUT") ?? []) as ToolId[],
  parse(a) {
    const campaign = String(a.campaign ?? "").trim();
    if (!campaign) return { error: "Which campaign? Give its name or number." };
    const email = Number(a.email);
    if (!Number.isInteger(email) || email < 1) return { error: "Which email? A number from 1." };
    const version = a.version === undefined || a.version === null || a.version === "" ? 1 : Number(a.version);
    if (!Number.isInteger(version) || version < 1) return { error: "version is a number from 1 (1 = the main email)." };
    const subject = typeof a.subject === "string" ? a.subject : undefined;
    const text = typeof a.text === "string" ? a.text : undefined;
    if (subject === undefined && text === undefined) return { error: "Give the new subject and/or text." };
    return { campaign, email, version, ...(subject === undefined ? {} : { subject }), ...(text === undefined ? {} : { text }) };
  },
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    const deps = realDeps();
    const [live, seq, sent] = await Promise.all([deps.liveCampaign(c.id), deps.liveSequence(c.id), deps.sentPerStep(c.id)]);
    const name = live.name || c.name;
    const state = stateOf(live.status);
    if (!state || state === "finished") return { ok: false, refusal: `${name} (#${c.id}) is ${live.status}: its emails aren't changed any more.` };
    if (!seq.steps.length) return { ok: false, refusal: `${name} (#${c.id}) has no emails yet — write them in the OS's sequence editor.` };
    const model = copyModel(seq.steps, sent);
    const e = model.emails[a.email - 1];
    if (!e) return { ok: false, refusal: `${name} has ${model.emails.length} email${model.emails.length === 1 ? "" : "s"}; there is no email ${a.email}.` };
    if (e.off) return { ok: false, refusal: `Email ${a.email} of ${name} is turned off; turn it on in the OS first.` };
    const v = e.versions[a.version - 1];
    if (!v) return { ok: false, refusal: `Email ${a.email} of ${name} has ${e.versions.length} version${e.versions.length === 1 ? "" : "s"} switched on; there is no version ${a.version}.` };
    // A reply in the first email's thread has no subject of its own (it goes out as "Re: <email 1's subject>"); the
    // planner keeps it as it is, so a subject asked for here would silently not happen — said instead.
    const replies = a.version === 1 ? e.threadReply : v.reply === true;
    if (a.subject !== undefined && replies && a.subject.trim() !== v.subject.trim()) {
      return { ok: false, refusal: `Email ${a.email}${a.version > 1 ? ` (version ${VERSION_LETTER(a.version - 1)})` : ""} of ${name} is sent as a reply in the first email's thread, so it has no subject of its own (it goes out as "Re: ${model.emails[0]?.versions[0]?.subject ?? ""}"). Leave the subject out, or change email 1's subject.` };
    }

    // The whole campaign as read, with this one version's wording changed.
    let input: SaveInput = {
      version: model.version,
      emails: model.emails.map((m, i) => ({
        id: m.id, waitBefore: m.waitBefore, threadReply: m.threadReply,
        versions: m.versions.map((x, j) => (i === a.email - 1 && j === a.version - 1
          ? { id: x.id, subject: a.subject ?? x.subject, text: a.text ?? x.text }
          : { id: x.id, subject: x.subject, text: x.text })),
      })),
    };
    // {CLIENT_AREA} in what changed: the campaign's area put in its place before the rules run (the portal's own step).
    if (inputUsesArea(input)) {
      let area: string | null;
      try {
        area = (await clientFieldValuesForCampaign("emailbison", c.id)).area;
      } catch {
        return { ok: false, refusal: "The campaign's client couldn't be read just now to fill {CLIENT_AREA}, so nothing can be changed. Try again in a minute." };
      }
      const filled = areaInChanged(seq.steps, input, area);
      if (filled.asks && !area) return { ok: false, refusal: `${name}'s client has no Area on record, so {CLIENT_AREA} can't be filled. Take it out, or add the Area (Clients → the client → Markets).` };
      input = filled.input;
    }
    const plan = planCopySave(seq.steps, input, sent);
    if (!plan.ok) {
      const problems = "problems" in plan && plan.problems.length ? ` ${plan.problems.map((p) => p.message).join(" ")}` : "";
      return { ok: false, refusal: `${plan.error}${problems}` };
    }
    if (plan.adds.length || plan.deletes.length) return { ok: false, refusal: "That would add or remove emails, which isn't done through Claude. Use the OS's sequence editor." };
    // Only the email asked about: an update that would only renumber another step (one EmailBison holds with no
    // number) is left out — EmailBison keeps it exactly as it is.
    const changedOnly = plan.updates.filter((u) => !u.orderOnly);
    if (!changedOnly.length) return { ok: false, refusal: `Email ${a.email}${a.version > 1 ? ` (version ${VERSION_LETTER(a.version - 1)})` : ""} of ${name} already says that.` };
    if (!seq.sequenceId) return { ok: false, refusal: "This campaign's emails couldn't be changed just now. Try again in a minute." };

    // Any client field still in what is written ({CLIENT_ALIAS}, or {CLIENT_AREA} already there): filled, as the OS editor does.
    let writes = changedOnly.map(({ orderOnly: _o, ...w }) => w);
    if (usesClientFields(writes.flatMap((w) => [w.email_subject, w.email_body]))) {
      let values;
      try {
        values = await clientFieldValuesForCampaign("emailbison", c.id);
      } catch {
        return { ok: false, refusal: "The campaign's client couldn't be read just now to fill its fields, so nothing can be changed. Try again in a minute." };
      }
      const f = fillSteps(writes, values);
      const problem = clientFieldsProblem(f.missing, values);
      if (problem) return { ok: false, refusal: problem };
      writes = f.value;
    }

    const newSubject = a.subject ?? v.subject;
    const newText = a.text ?? v.text;
    const which = `email ${a.email}${a.version > 1 ? ` (version ${VERSION_LETTER(a.version - 1)})` : ""}`;
    const parts = [
      a.subject !== undefined && a.subject.trim() !== v.subject.trim() ? `Subject: "${v.subject}" → "${newSubject.trim()}".` : `Subject stays "${v.subject}".`,
      a.text !== undefined ? `Text now (${words(v.text)} words): «${clip(v.text)}» — becomes (${words(newText)} words): «${newText.trim()}».` : "Text stays as it is.",
      e.sent ? `It has gone to ${e.sent.toLocaleString("en-US")} leads already; the new wording is for everyone who gets it from now on.` : "",
    ].filter(Boolean);
    return {
      ok: true,
      preview: `Change ${which} of "${name}" (#${c.id}, ${live.status}). ${parts.join(" ")}`,
      details: { before: { subject: v.subject, text: v.text }, after: { subject: newSubject, text: newText }, summary: plan.summary, writtenAs: writes.map((w) => ({ subject: w.email_subject, text: htmlToText(w.email_body) })) },
      bind: { id: c.id, name, sequenceId: seq.sequenceId, fingerprint: model.version, writes },
    };
  },
  async execute(a, v, bind) {
    const deps = realDeps();
    const before = (await deps.liveSequence(bind.id)).steps.filter((s) => bind.writes.some((w) => w.id === s.id));
    const actor = `${v.email} via Claude`;
    const audit = (ok: boolean, error: string | null) => getAnalyticsSupabase().from("campaign_audit_log").insert({
      team_id: analyticsTeamId(),
      campaign_id: bind.id,
      campaign_name: bind.name,
      action: "edit-sequence",
      actor,
      status: ok ? "ok" : "error",
      error,
      before_state: { from: "Claude", steps: before.map((s) => ({ id: s.id, order: s.order, email_subject: s.subject, email_body: s.body })) },
      after_state: ok ? { updated: bind.writes.length, steps: bind.writes.map((w) => ({ id: w.id, email_subject: w.email_subject, email_body: w.email_body })) } : null,
    });
    try {
      await deps.updateSteps(bind.sequenceId, bind.name, bind.writes as StepWrite[]);
    } catch (e) {
      const message = describeEmailBisonError(e);
      await audit(false, message);
      throw new Error(`EmailBison refused the change, so nothing was saved: ${message}`);
    }
    await audit(true, null);
    // What EmailBison holds now, read back: said plainly if it isn't what was written.
    const now = (await deps.liveSequence(bind.id)).steps;
    const landed = bind.writes.every((w) => {
      const s = now.find((x) => x.id === w.id);
      return !!s && htmlToText(s.body) === htmlToText(w.email_body) && s.subject.replace(/^(?:re:\s*)+/i, "").trim() === w.email_subject.replace(/^(?:re:\s*)+/i, "").trim();
    });
    console.info(`[mcp-action] ${actor}: edited email ${a.email} v${a.version} of campaign #${bind.id} (${landed ? "confirmed" : "NOT confirmed on read-back"})`);
    return { campaign: bind.name, number: bind.id, email: a.email, version: a.version, confirmedInEmailBison: landed };
  },
};
