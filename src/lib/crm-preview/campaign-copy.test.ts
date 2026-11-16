import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedFields,
  applyPlan,
  bareSubject,
  copyModel,
  copyProblem,
  COPY_RULES,
  fieldsIn,
  htmlToText,
  planCopySave,
  previewText,
  sequenceVersion,
  subjectLength,
  textToHtml,
  waitProblem,
  wordCount,
  type LiveStep,
  type SaveInput,
} from "./campaign-copy";

/* A campaign shaped like BrokerStaffer's real ones (campaign 1263, 17 Nov): 3 main emails, the first with an A/B
   version and a turned-off one; follow-ups are replies in the same thread; versions numbered after the main steps. */
function campaign(): LiveStep[] {
  return [
    { id: 10, order: 1, subject: "{FIRST_NAME} × SERHANT.", body: "<p>{Hey|Hi} {FIRST_NAME},<br><br></p><p>Open to more deals?</p>", wait: 2, variant: false, parentId: null, threadReply: false, active: true },
    { id: 11, order: 2, subject: "Re: Opportunity with SERHANT.", body: "<p>Following up on my note.</p>", wait: 3, variant: false, parentId: null, threadReply: true, active: true },
    { id: 12, order: 3, subject: "Re: Opportunity with SERHANT.", body: "<p>Last one from me, {FIRST_NAME}.</p>", wait: 1, variant: false, parentId: null, threadReply: true, active: true },
    { id: 13, order: 4, subject: "Potential fit with SERHANT.", body: "<p>Hi {FIRST_NAME}, a quick question.</p>", wait: 1, variant: true, parentId: 10, threadReply: false, active: true },
    { id: 14, order: 5, subject: "{SUBJECT PHONE}?", body: "<p>Old version.</p>", wait: 1, variant: true, parentId: 10, threadReply: false, active: false },
  ];
}

/** The editor's save of the model unchanged. */
function asSaved(steps: LiveStep[], sent = new Map<number, number>()): SaveInput {
  const m = copyModel(steps, sent);
  return { version: m.version, emails: m.emails.map((e) => ({ id: e.id, waitBefore: e.waitBefore, threadReply: e.threadReply, versions: e.versions.map((v) => ({ ...v })) })) };
}

const ok = (p: ReturnType<typeof planCopySave>) => {
  assert.equal(p.ok, true, JSON.stringify(p));
  return p as Extract<typeof p, { ok: true }>;
};
const refused = (p: ReturnType<typeof planCopySave>) => {
  assert.equal(p.ok, false, JSON.stringify(p));
  return p as Extract<typeof p, { ok: false }>;
};

/* ------------------------------------------------------------------------------------------- text and HTML --- */

test("an email body reads as plain text: paragraphs, line breaks, entities, no formatting", () => {
  assert.equal(htmlToText("<p>{Hey|Hi} {FIRST_NAME},<br><br></p><p>Open to more deals?</p>"), "{Hey|Hi} {FIRST_NAME},\n\nOpen to more deals?");
  assert.equal(htmlToText('<p dir="ltr" style="line-height:1.38"><span style="font-size:11pt">Tom &amp; Jerry&nbsp;&rsquo;s</span></p><div>Line two</div>'), "Tom & Jerry ’s\n\nLine two");
  assert.equal(htmlToText("One<br>Two<br/>Three"), "One\nTwo\nThree");
  assert.equal(htmlToText(""), "");
});

test("plain text becomes simple HTML, escaped, and reads back the same", () => {
  assert.equal(textToHtml("Hi {FIRST_NAME},\n\nA < B & C\nnext line"), "<p>Hi {FIRST_NAME},</p><p>A &lt; B &amp; C<br>next line</p>");
  for (const t of ["Hi,\n\nBody\nline", "One paragraph only", "{Hey|Hi} {FIRST_NAME},\n\n\n\nGap"]) {
    assert.equal(htmlToText(textToHtml(t)), htmlToText(textToHtml(htmlToText(textToHtml(t)))));
  }
  assert.equal(htmlToText(textToHtml("A\n\n\n\nB")), "A\n\nB");
});

test("a reply's subject is written back without the Re: EmailBison adds itself", () => {
  assert.equal(bareSubject("Re: Re: Hello", true), "Hello");
  assert.equal(bareSubject("Re: Hello", false), "Re: Hello");
});

/* ---------------------------------------------------------------------------------- choices, fields, counts --- */

test("words count each choice at its longest, a field as one word", () => {
  assert.equal(wordCount("{Hi|Hello there} {FIRST_NAME}, how are you?"), 6);
  assert.equal(wordCount("{{FIRST_NAME}}, {a|{b c|d e f}}"), 4);
  assert.equal(wordCount("Unclosed {brace"), null);
});

test("a subject's length counts fields as their sample and choices at their longest", () => {
  assert.equal(subjectLength("{FIRST_NAME}?"), "Jordan?".length);
  assert.equal(subjectLength("{Hi|Hello there}"), "Hello there".length);
  assert.equal(subjectLength("{CUSTOM}"), 10);
});

test("the fields a campaign uses are found, inside choices and double braces too", () => {
  assert.deepEqual(fieldsIn("{Hey|Hi {FIRST_NAME}} {{AREA}} {SUBJECT PHONE}").sort(), ["AREA", "FIRST_NAME", "SUBJECT PHONE"]);
  assert.deepEqual(fieldsIn("broken {"), []);
  const f = allowedFields(campaign());
  assert.ok(f.includes("FIRST_NAME") && f.includes("SENDER_FULL_NAME") && f.includes("SUBJECT PHONE"));
});

test("the preview fills sample names and picks one choice", () => {
  assert.equal(previewText("{Hey|Hi} {FIRST_NAME}, from {SENDER_FIRST_NAME}", 0), "Hey Jordan, from Alex");
  assert.equal(previewText("{Hey|Hi} {FIRST_NAME}", 1), "Hi Jordan");
  assert.equal(previewText("{{FIRST_NAME}} and {CUSTOM}", 0), "Jordan and {CUSTOM}");
});

/* ------------------------------------------------------------------------------------------------ the rules --- */

const fields = new Set(["FIRST_NAME", "SENDER_FIRST_NAME", "SENDER_FULL_NAME"]);

test("links, web and email addresses, formatting and images are refused", () => {
  for (const bad of [
    "Visit https://brokerstaffer.com today",
    "See www.example.org",
    "Go to compass.com for more",
    "Email me at amy@brokerstaffer.com",
    "mailto:someone",
    "<b>bold</b> words",
    '<img src="x.png">',
    "![logo](x)",
    "Our site is kw.realty",
  ]) {
    assert.ok(copyProblem(bad, "text", fields), bad);
  }
  for (const fine of ["Hi {FIRST_NAME}, call 555-123-4567.", "We're at 5 a.m. e.g. Mon. Inc. St. U.S.", "RE/MAX and eXp Realty agents", "3.5% split, 1.2M in sales", "Just a quick question...yes."]) {
    assert.equal(copyProblem(fine, "text", fields), null, fine);
  }
});

test("at most 125 words and a 60-character subject", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(copyProblem(words(COPY_RULES.maxWords), "text", fields), null);
  assert.match(copyProblem(words(COPY_RULES.maxWords + 1), "text", fields)!, /126 words; the limit is 125/);
  assert.equal(copyProblem("x".repeat(60), "subject", fields), null);
  assert.match(copyProblem("x".repeat(61), "subject", fields)!, /61 characters; the limit is 60/);
  // The longest choice counts.
  assert.match(copyProblem(`{short|${words(130)}}`, "text", fields)!, /130 words/);
});

test("only the campaign's own fields; a lowercase or unknown one is named", () => {
  assert.match(copyProblem("Hi {FIRST_NAM}", "text", fields)!, /\{FIRST_NAM\} isn't a field this campaign can fill/);
  assert.match(copyProblem("Hi {first_name}", "text", fields)!, /isn't a field\. For a choice of words/);
  assert.match(copyProblem("Hi {FIRST_NAME", "text", fields)!, /isn't closed/);
  assert.match(copyProblem("Hi FIRST_NAME}", "text", fields)!, /no "\{" before it/);
  assert.equal(copyProblem("{{FIRST_NAME}}, {Hi|Hello}", "text", fields), null);
});

test("empty copy, and a subject on two lines, are refused", () => {
  assert.match(copyProblem("  \n ", "text", fields)!, /Write this email/);
  assert.match(copyProblem("", "subject", fields)!, /Add a subject/);
  assert.match(copyProblem("one\ntwo", "subject", fields)!, /one line/);
});

test("days between emails are whole numbers from 1 to 30", () => {
  assert.equal(waitProblem(1), null);
  assert.equal(waitProblem(30), null);
  for (const bad of [0, 31, 2.5, NaN, null, "3"]) assert.ok(waitProblem(bad), String(bad));
});

/* ------------------------------------------------------------------------------------------------ the model --- */

test("the editor's view: main emails in order, switched-on versions, days after the previous email", () => {
  const m = copyModel(campaign(), new Map([[10, 40], [13, 7], [11, 12]]));
  assert.deepEqual(m.emails.map((e) => e.id), [10, 11, 12]);
  assert.deepEqual(m.emails.map((e) => e.waitBefore), [null, 2, 3]);
  assert.deepEqual(m.emails.map((e) => e.threadReply), [false, true, true]);
  assert.deepEqual(m.emails[0].versions.map((v) => v.id), [10, 13]); // the turned-off version 14 isn't shown
  assert.equal(m.emails[1].versions[0].subject, "Opportunity with SERHANT."); // bare
  assert.deepEqual(m.emails.map((e) => e.sent), [47, 12, 0]);
  assert.equal(m.version, sequenceVersion(campaign()));
});

test("the version changes with any change to the sequence, and not otherwise", () => {
  const a = campaign();
  const b = campaign();
  assert.equal(sequenceVersion(a), sequenceVersion([...b].reverse()));
  b[2].body = "<p>Changed by the team.</p>";
  assert.notEqual(sequenceVersion(a), sequenceVersion(b));
});

/* ------------------------------------------------------------------------------------------------- the plan --- */

test("saving nothing changed writes nothing", () => {
  const p = ok(planCopySave(campaign(), asSaved(campaign())));
  assert.deepEqual([p.updates, p.adds, p.deletes, p.summary], [[], [], [], []]);
});

test("a stale page is refused (the team changed the emails meanwhile)", () => {
  const input = asSaved(campaign());
  const live = campaign();
  live[1].body = "<p>Team edit.</p>";
  const p = refused(planCopySave(live, input));
  assert.equal(p.status, 409);
});

test("changing wording rewrites only that step, as simple HTML, keeping its subject bare", () => {
  const input = asSaved(campaign());
  input.emails[1].versions[0].text = "New follow-up, {FIRST_NAME}.";
  const p = ok(planCopySave(campaign(), input));
  assert.equal(p.updates.length, 1);
  assert.deepEqual(p.updates[0], { id: 11, email_subject: "Opportunity with SERHANT.", email_body: "<p>New follow-up, {FIRST_NAME}.</p>", order: 2, wait_in_days: 3, variant: false, thread_reply: true });
  assert.deepEqual(p.summary, ["Email 2: wording changed"]);
});

test("a version's change carries its main step's id (the field EmailBison requires — the editor's 26 Oct failure)", () => {
  const input = asSaved(campaign());
  input.emails[0].versions[1].subject = "A better subject";
  const p = ok(planCopySave(campaign(), input));
  assert.deepEqual(p.updates, [{ id: 13, email_subject: "A better subject", email_body: "<p>Hi {FIRST_NAME}, a quick question.</p>", order: 4, wait_in_days: 1, variant: true, variant_from_step_id: 10, thread_reply: false }]);
  assert.deepEqual(p.summary, ["Email 1: version B subject changed"]);
});

test("changing the days moves the PREVIOUS step's wait", () => {
  const input = asSaved(campaign());
  input.emails[2].waitBefore = 7;
  const p = ok(planCopySave(campaign(), input));
  assert.deepEqual(p.updates.map((u) => [u.id, u.wait_in_days]), [[11, 7]]);
  assert.deepEqual(p.summary, ["Email 3: now 7 days after email 2 (was 3 days)"]);
});

test("adding an email: appended, a reply under the first subject, the old last step's wait set, versions left alone", () => {
  const input = asSaved(campaign());
  input.emails.push({ id: null, waitBefore: 4, threadReply: true, versions: [{ id: null, subject: "", text: "One more note." }] });
  const p = ok(planCopySave(campaign(), input));
  assert.deepEqual(p.adds, [{ email_subject: "{FIRST_NAME} × SERHANT.", email_body: "<p>One more note.</p>", order: 4, wait_in_days: 1, variant: false, thread_reply: true }]);
  // Email 3's wait becomes the new gap. The versions keep their numbers (4 and 5): renumbering a version shifts emails.
  assert.deepEqual(p.updates.map((u) => [u.id, u.order, u.wait_in_days, u.orderOnly ?? false]), [[12, 3, 4, false]]);
  assert.deepEqual(p.summary, ["Added email 4, 4 days after email 3, as a reply in the same thread"]);
});

test("a new email with its own subject must have a valid one", () => {
  const input = asSaved(campaign());
  input.emails.push({ id: null, waitBefore: 2, threadReply: false, versions: [{ id: null, subject: "", text: "Hello again." }] });
  const p = refused(planCopySave(campaign(), input));
  assert.equal(p.status, 422);
  assert.deepEqual((p as { problems: unknown[] }).problems, [{ email: 3, version: 0, field: "subject", message: "Add a subject." }]);
});

test("removing an unsent email: its versions first, the gap carried by the email after it", () => {
  const input = asSaved(campaign());
  input.emails.splice(1, 1); // remove email 2 (unsent)
  input.emails[1].waitBefore = 5;
  const p = ok(planCopySave(campaign(), input));
  assert.deepEqual(p.deletes, [11]);
  // Email 1 carries the new gap; email 3 moves to 2 (only its number: sent only if EmailBison hasn't moved it already).
  assert.deepEqual(p.updates.map((u) => [u.id, u.order, u.wait_in_days, u.orderOnly ?? false]), [[10, 1, 5, false], [12, 2, 1, true]]);
  assert.deepEqual(p.summary, ["Email 2: now 5 days after email 1", "Removed email 2 (it hadn't been sent)"]);
});

test("an email that has been sent, the first email, and a turned-off one can't be removed", () => {
  const sent = new Map([[11, 3]]);
  const a = asSaved(campaign(), sent);
  a.emails.splice(1, 1);
  assert.match(refused(planCopySave(campaign(), a, sent)).error, /already been sent to 3 agents/);
  const b = asSaved(campaign());
  b.emails.shift();
  assert.match(refused(planCopySave(campaign(), b)).error, /first email can't be removed/);
  const off = campaign();
  off[1].active = false;
  const c = asSaved(off);
  c.emails.splice(1, 1);
  assert.match(refused(planCopySave(off, c)).error, /turned off by our team/);
});

test("reordering, new emails before old ones, extra versions and too many emails are refused", () => {
  const a = asSaved(campaign());
  [a.emails[1], a.emails[2]] = [a.emails[2], a.emails[1]];
  assert.match(refused(planCopySave(campaign(), a)).error, /reordered/);
  const b = asSaved(campaign());
  b.emails.splice(1, 0, { id: null, waitBefore: 1, threadReply: true, versions: [{ id: null, subject: "", text: "x" }] });
  assert.match(refused(planCopySave(campaign(), b)).error, /after the existing ones/);
  const c = asSaved(campaign());
  c.emails[0].versions.push({ id: null, subject: "s", text: "t" });
  assert.match(refused(planCopySave(campaign(), c)).error, /changed since you opened/);
  const d = asSaved(campaign());
  while (d.emails.length <= COPY_RULES.maxEmails) d.emails.push({ id: null, waitBefore: 1, threadReply: true, versions: [{ id: null, subject: "", text: "x" }] });
  assert.match(refused(planCopySave(campaign(), d)).error, /at most 10 emails/);
});

test("rules apply to what changed: a team email over the limit can stay; an edited one must fit", () => {
  const live = campaign();
  live[2].body = `<p>${Array.from({ length: 140 }, () => "word").join(" ")}</p>`;
  const untouched = asSaved(live);
  untouched.emails[1].versions[0].text = "Short and fine.";
  ok(planCopySave(live, untouched));
  const edited = asSaved(live);
  edited.emails[2].versions[0].text += " more";
  const p = refused(planCopySave(live, edited));
  assert.deepEqual((p as { problems: Array<{ email: number; field: string }> }).problems.map((x) => [x.email, x.field]), [[2, "text"]]);
});

test("every problem is listed with where it is", () => {
  const input = asSaved(campaign());
  input.emails[0].versions[0].text = "See https://x.com";
  input.emails[0].versions[1].subject = "";
  input.emails[2].waitBefore = 0;
  const p = refused(planCopySave(campaign(), input)) as { status: number; error: string; problems: Array<{ email: number; version?: number; field: string }> };
  assert.equal(p.status, 422);
  assert.equal(p.error, "3 things need fixing before this can be saved.");
  assert.deepEqual(p.problems.map((x) => [x.email, x.version ?? null, x.field]), [[0, 0, "text"], [0, 1, "subject"], [2, null, "wait"]]);
});

test("a follow-up turned into its own email needs a subject; turned back into a reply it keeps the stored one", () => {
  const input = asSaved(campaign());
  input.emails[1].threadReply = false;
  input.emails[1].versions[0].subject = "Fresh subject";
  const p = ok(planCopySave(campaign(), input));
  assert.deepEqual(p.updates, [{ id: 11, email_subject: "Fresh subject", email_body: "<p>Following up on my note.</p>", order: 2, wait_in_days: 3, variant: false, thread_reply: false }]);
  assert.deepEqual(p.summary, ["Email 2: now sent as a new email with its own subject, subject changed"]);
  const back = asSaved(campaign());
  back.emails[0].threadReply = true;
  assert.match(refused(planCopySave(campaign(), back)).error, /first email can't be sent as a reply/);
});

test("a plan applied gives the sequence the editor then shows", () => {
  const input = asSaved(campaign());
  input.emails[1].versions[0].text = "Edited.";
  input.emails.push({ id: null, waitBefore: 2, threadReply: true, versions: [{ id: null, subject: "", text: "Added." }] });
  input.emails.splice(2, 1);
  input.emails[2].waitBefore = 2;
  const p = ok(planCopySave(campaign(), input));
  let next = 100;
  const after = applyPlan(campaign(), p, () => next++);
  const m = copyModel(after);
  assert.deepEqual(m.emails.map((e) => e.versions[0].text), ["{Hey|Hi} {FIRST_NAME},\n\nOpen to more deals?", "Edited.", "Added."]);
  assert.deepEqual(m.emails.map((e) => e.waitBefore), [null, 2, 2]);
  assert.deepEqual(m.emails.map((e) => e.threadReply), [false, true, true]);
  // And saving that view again changes nothing.
  const again = ok(planCopySave(after, asSaved(after)));
  assert.deepEqual([again.updates, again.adds, again.deletes], [[], [], []]);
});

test("a version is never renumbered; one stored without a number gets one after every step, only when it is written", () => {
  const live = campaign();
  live[3].order = null;
  const untouched = asSaved(live);
  untouched.emails.push({ id: null, waitBefore: 2, threadReply: true, versions: [{ id: null, subject: "", text: "New." }] });
  const a = ok(planCopySave(live, untouched));
  assert.ok(!a.updates.some((u) => u.variant), "an unchanged version isn't written at all");
  const edited = asSaved(live);
  edited.emails[0].versions[1].text = "Edited B.";
  const b = ok(planCopySave(live, edited));
  assert.deepEqual(b.updates.map((u) => [u.id, u.order, u.variant, u.variant_from_step_id]), [[13, 6, true, 10]]);
});

test("a plan applied after a removal gives the emails 1..n and leaves the versions' numbers", () => {
  const input = asSaved(campaign());
  input.emails.splice(1, 1);
  const p = ok(planCopySave(campaign(), input));
  const after = applyPlan(campaign(), p, () => 99);
  assert.deepEqual(after.filter((s) => !s.variant).map((s) => [s.id, s.order]).sort((a, b) => Number(a[0]) - Number(b[0])), [[10, 1], [12, 2]]);
  assert.deepEqual(after.filter((s) => s.variant).map((s) => [s.id, s.order]), [[13, 4], [14, 5]]);
});

/* ------------------------------------------------------------------- the independent review's findings (17 Nov) --- */

test("a link split across choices is still a link", () => {
  for (const bad of ["brokerstaffer{.|.}com", "https{:|:}//x.io", "bob{@|@}gmail{.|.}com", "{see www|visit www}.acme.com", "Visit acme{.com| dot com}", "{www|ww}{.|.}{acme|kw}.org", "{FIRST_NAME}{.|.}com"]) {
    assert.ok(copyProblem(bad, "text", fields), bad);
  }
  // Choices that build no link stay fine, the team's real ones included.
  for (const fine of [
    "{Hey|Hi|Hello} {FIRST_NAME}, {we're getting|our office is receiving} more requests than {our team can handle|we can cover}.",
    "{3.5%|three and a half percent} split on {every deal|each closing}.",
    "{Best|Thanks|Cheers},\n{SENDER_FULL_NAME}",
    "{FIRST_NAME}. {Quick one|One question}: {open|up} for a call?",
    "{{FIRST_NAME}}, {e.g.|for example} the {U.S.|US} market",
  ]) {
    assert.equal(copyProblem(fine, "text", fields), null, fine);
  }
});

test("too many choices glued together are refused rather than half-checked", () => {
  const glued = Array.from({ length: 6 }, () => "{a|b|c|d|e}").join("");
  assert.match(copyProblem(glued, "text", fields)!, /Too many choices are joined together/);
  // The same choices with spaces between are fine.
  assert.equal(copyProblem(Array.from({ length: 6 }, () => "{a|b|c|d|e}").join(" "), "text", fields), null);
});

test("the gap in front of an email the team turned off can't be changed (it is the live email before's)", () => {
  const live = campaign();
  live[2].active = false; // email 3 off
  const input = asSaved(live);
  input.emails[2].waitBefore = -7;
  const p = refused(planCopySave(live, input)) as { problems: Array<{ email: number; field: string }> };
  assert.deepEqual(p.problems.map((x) => [x.email, x.field]), [[2, "email"]]);
});

test("a campaign the team made longer than 10 emails can still be edited; adding past 10 is refused", () => {
  const long: LiveStep[] = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, order: i + 1, subject: i ? "Re: S" : "S", body: `<p>Email ${i + 1}</p>`, wait: 1, variant: false, parentId: null, threadReply: i > 0, active: true }));
  const edit = asSaved(long);
  edit.emails[3].versions[0].text = "Changed.";
  ok(planCopySave(long, edit));
  const add = asSaved(long);
  add.emails.push({ id: null, waitBefore: 1, threadReply: true, versions: [{ id: null, subject: "", text: "x" }] });
  assert.match(refused(planCopySave(long, add)).error, /at most 10 emails/);
});

test("an email with A/B versions isn't removed here (its versions would go first)", () => {
  const live = campaign();
  live.push({ id: 15, order: 6, subject: "Re: x", body: "<p>2B</p>", wait: 1, variant: true, parentId: 11, threadReply: true, active: true });
  const input = asSaved(live);
  input.emails.splice(1, 1);
  assert.match(refused(planCopySave(live, input)).error, /has A\/B versions, so it can't be removed here/);
});

test("a version follows the email's 'reply' setting when the client changes it, and needs a subject then", () => {
  const live = campaign();
  live.push({ id: 15, order: 6, subject: "Re: Opportunity with SERHANT.", body: "<p>2B</p>", wait: 1, variant: true, parentId: 11, threadReply: true, active: true });
  const m = copyModel(live);
  assert.equal(m.emails[1].versions[1].reply, true);
  const input = asSaved(live);
  input.emails[1].threadReply = false;
  input.emails[1].versions[0].subject = "Own subject A";
  input.emails[1].versions[1].subject = "";
  const p = refused(planCopySave(live, input)) as { problems: Array<{ email: number; version?: number; field: string }> };
  assert.deepEqual(p.problems.map((x) => [x.email, x.version, x.field]), [[1, 1, "subject"]]);
  input.emails[1].versions[1].subject = "Own subject B";
  const q = ok(planCopySave(live, input));
  assert.deepEqual(q.updates.map((u) => [u.id, u.thread_reply, u.email_subject]), [[11, false, "Own subject A"], [15, false, "Own subject B"]]);
  // Untouched, a version keeps its own setting.
  const same = ok(planCopySave(live, asSaved(live)));
  assert.deepEqual(same.updates, []);
});

test("a refused save from an out-of-date page says so by its code", () => {
  const input = asSaved(campaign());
  input.version = "old";
  const p = refused(planCopySave(campaign(), input)) as { code?: string };
  assert.equal(p.code, "stale");
});

/* ------------------------------------------------------------- the second review's findings (17 Nov) --- */

test("choices nest 3 deep at most, and counting never slows down with depth or length", () => {
  const deep = `Hi ${"{".repeat(4)}a|b}|b}|b}|b}`;
  const t0 = performance.now();
  assert.match(copyProblem(deep, "text", fields)!, /3 levels deep at most/);
  assert.equal(wordCount(deep), null);
  // The reviewer's case, 200 braces deep: refused at once (it took minutes before).
  const evil = `Hi ${"{".repeat(100)}a|b${"}|b".repeat(99)}}`;
  assert.ok(copyProblem(evil, "text", fields));
  assert.equal(subjectLength(evil), null);
  // A long email 3 deep with many choices (the team's own deepest shape) counts in a blink.
  const wide = Array.from({ length: 40 }, (_, i) => `{{Hi {FIRST_NAME}|Hello {FIRST_NAME}}|Hey there} word${i}`).join(" ");
  assert.equal(typeof wordCount(wide), "number");
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0} ms`);
});

test("a link hidden past what a quick check would look at is still caught, or the text refused", () => {
  const many = `Visit {{${Array.from({ length: 64 }, () => "_").join("|")}|acme}.com} today`;
  assert.ok(copyProblem(many, "text", fields), "the 65th way builds acme.com");
  const glued = "Visit {{_|acme}{a|a}{a|a}{a|a}{a|a}{a|a}{a|a}.com} today";
  assert.ok(copyProblem(glued, "text", fields), "acmeaaaaaa.com");
});

test("removing the email before one the team turned off is refused, naming the turned-off email", () => {
  const live = campaign();
  live[2].active = false; // email 3 off
  const input = asSaved(live);
  input.emails.splice(1, 1); // remove email 2: email 3's gap would now follow email 1
  const p = refused(planCopySave(live, input));
  assert.match(p.error, /Email 2 was turned off by our team, so the email before it, and the days between them, stay as they are/);
});

test("what can be removed: not the first, not sent, not off, and no A/B versions (even switched-off ones)", () => {
  const live = campaign();
  live.push({ id: 16, order: 7, subject: "x", body: "<p>x</p>", wait: 1, variant: true, parentId: 12, threadReply: true, active: false });
  const m = copyModel(live, new Map([[11, 2]]));
  assert.deepEqual(m.emails.map((e) => e.removable), [false, false, false]);
  const m2 = copyModel(campaign());
  assert.deepEqual(m2.emails.map((e) => e.removable), [false, true, true]);
});
