/*
 * The Help page's articles (4 Nov): every link on the page has its article, and they hold together. The words themselves
 * were checked against the client's document when they were copied; this keeps the page and the data from drifting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { articleBySlug, articleByTitle, articleText, HELP_ARTICLES } from "./help-articles.ts";

const page = readFileSync("src/components/crm-preview/static-pages.tsx", "utf8");
const topics = page.slice(page.indexOf("const TOPICS"), page.indexOf("const FAQ"));
const links = [...topics.matchAll(/links: \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));

test("twelve articles, and every link on the Help page opens one: none missing, none spare, each once", () => {
  assert.equal(HELP_ARTICLES.length, 12);
  assert.deepEqual([...links].sort(), HELP_ARTICLES.map((a) => a.title).sort());
  assert.equal(new Set(HELP_ARTICLES.map((a) => a.slug)).size, 12);
  for (const a of HELP_ARTICLES) {
    assert.match(a.slug, /^[a-z0-9-]+$/, a.title);
    assert.equal(articleBySlug(a.slug), a);
    assert.equal(articleByTitle(a.title), a);
    assert.ok(a.blocks.length >= 3, `${a.title} has its body`);
  }
  for (const none of ["", "nope", null, undefined, "__proto__"]) assert.equal(articleBySlug(none), null);
});

test("an article's own text never carries markup, a broken bold, or an email or phone number", () => {
  for (const a of HELP_ARTICLES) {
    const text = articleText(a);
    assert.doesNotMatch(text, /\*\*|<[a-z]|&[a-z]+;/, a.title);
    assert.doesNotMatch(text, /[^\s@]+@[^\s@]+\.[^\s@]+|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, `${a.title}: no contact details`);
    for (const b of a.blocks) {
      const strings = "p" in b ? [b.p] : "h" in b ? [b.h] : "ol" in b ? b.ol : "ul" in b ? b.ul : [...b.table.head, ...b.table.rows.flat()];
      for (const s of strings) assert.equal((s.match(/\*\*/g) ?? []).length % 2, 0, `${a.title}: every bold is closed: ${s}`);
    }
  }
});

test("tables are square: every row as wide as its header", () => {
  const tables = HELP_ARTICLES.flatMap((a) => a.blocks.filter((b) => "table" in b).map((b) => ({ title: a.title, table: (b as { table: { head: string[]; rows: string[][] } }).table })));
  assert.deepEqual(tables.map((t) => t.title), ["Board and list views", "Importing a CSV"]);
  for (const { title, table } of tables) for (const r of table.rows) assert.equal(r.length, table.head.length, title);
});

test("what one article points to is another article: 'See <title>' is a link where it's drawn", () => {
  const see = HELP_ARTICLES.flatMap((a) => [...articleText(a).matchAll(/\b[Ss]ee ([A-Z][a-zA-Z ]{3,})/g)].map((m) => m[1]));
  assert.ok(see.length >= 2, see.join(", "));
  const titles = HELP_ARTICLES.map((a) => a.title);
  for (const s of see) {
    if (/^Conversation\b/.test(s)) continue;
    assert.ok(titles.some((t) => s.startsWith(t)), `${s} names an article`);
  }
});

test("the Help page's controls work: no article link or the tour is left switched off", () => {
  assert.doesNotMatch(page, /isn't written yet|isn't built yet/);
  assert.match(page, /data-tour-start onClick=\{onTour\}/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/, "the client's words are text, never markup");
});

/* 5 Nov: the corrected wording, against the portal it describes. Team never chooses who gets an interested agent's email. */
const allWords = HELP_ARTICLES.map(articleText).join("\n");
const screen = (f: string) => readFileSync(`src/components/crm-preview/${f}.tsx`, "utf8");

test("nothing still says Team or the Active switch decides who gets interested agents", () => {
  for (const gone of [/every active member/i, /active team members/i, /active members/i, /inactive members/i, /everyone on your team can see/i, /once they're on your team and active/i, /at least one (other )?person (is still )?active/i, /recipient on or off/i, /every interested agent's email thread/i, /should get interested agents/i, /your team members and add/i, /email thread goes to your team/i]) {
    assert.doesNotMatch(allWords, gone);
  }
});

test("who receives them: the contacts on the account, how to see them and how to change them, each in words the portal has", () => {
  const who = articleText(articleBySlug("who-receives-interested-agents")!);
  assert.match(who, /Interested agents go to the contacts on your account, not to everyone on your team/);
  assert.match(who, /click Chat with support and ask the assistant who receives your interested agents\. It gives you their names and emails/);
  assert.match(who, /To change them, chat with support and ask for a person, and our team will update them/);
  assert.match(screen("static-pages"), />\s*<Icon name="chat" size=\{15\} \/>Chat with support<\/button>/);
  assert.equal(articleBySlug("turning-a-recipient-on-or-off"), null);
  assert.match(articleText(articleByTitle("Turning a teammate on or off")!), /doesn't change who receives interested agents.*If text alerts are on for your account, the switch decides who gets them/s);
});

test("each corrected instruction names a control the portal really has", () => {
  const pipeline = screen("pipeline");
  const pages = screen("pages");
  const setup = screen("setup");
  const stages = articleText(articleBySlug("moving-agents-between-stages")!);
  assert.doesNotMatch(stages, /Next to Stage|click Edit|No show,|or No show/);
  assert.match(stages, /drag the agent's card to the new stage/);
  assert.match(pipeline, /<ChooseMenu className=\{k\(`pill p-\$\{placement\.stage\.pill\}`\)\}/, "the stage on a List row opens a menu");
  assert.match(stages, /Interested on pay-per-lead plans, otherwise Introduction/);
  for (const tag of ["Phone screen no show", "Interview no show"]) assert.ok(stages.includes(tag), tag);

  const block = articleText(articleBySlug("blocking-a-company-or-domain")!);
  assert.doesNotMatch(block, /Choose Company|Choose Agent/);
  assert.match(block, /Click Import CSV\..*company in the kind column/s);
  assert.match(block, /Click Add to DNC and enter their name and email/);
  assert.match(pages, /actions=\{\["Add to DNC", "Import CSV"\]\}/);

  assert.doesNotMatch(allWords, /by your office/);
  assert.match(articleText(articleBySlug("your-first-week")!), /Find your office under the Brokerage filter/);
  assert.match(setup, /Find your office under the Brokerage filter/);
  assert.match(screen("market"), /label="Brokerage"/);

  const week = articleText(articleBySlug("your-first-week")!);
  assert.doesNotMatch(week, /pick up where you left off/);
  assert.match(week, /your offer is saved only when you click Finish setup, and setup reopens at step 1/);
  assert.match(setup, /"Finish setup"/);
  assert.match(setup, />Save and exit</);

  const reply = articleText(articleBySlug("replying-to-an-interested-agent")!);
  assert.match(reply, /On the Board, click the agent's card to open their profile/);
  assert.doesNotMatch(reply, /Click the agent's name to open/);
  assert.match(articleText(articleBySlug("importing-a-csv")!), /Every row needs a name/);
  assert.match(articleText(articleBySlug("board-and-list-views")!), /or Conversation to read the emails/);
});

test("the links between articles reach the renamed one, on both the page and in the text", () => {
  assert.match(page, /"Turning a teammate on or off"/);
  assert.match(articleText(articleBySlug("setting-up-your-team")!), /see Turning a teammate on or off/);
  for (const slug of ["setting-up-your-team", "replying-to-an-interested-agent", "turning-a-teammate-on-or-off"]) assert.match(articleText(articleBySlug(slug)!), /see Who receives interested agents/, slug);
});

/*
 * 9 Nov: the chat is the assistant, so a person is reached through its "Ask for a person" (an email address today; a
 * person in the chat once that is built). Every "chat with support" that promises our team acts says so.
 */
test("every promise that our team acts goes through Ask for a person; replies go to everyone on the email", () => {
  const faq = page.slice(page.indexOf("const FAQ"), page.indexOf("];", page.indexOf("const FAQ"))).replace(/\u00a0/g, " ");
  const lines = [...HELP_ARTICLES.flatMap((a) => articleText(a).split(/(?<=[.!?])\s+/)), ...faq.split(/(?<=[.!?])\s+/)];
  const acts = lines.filter((l) => /chat with support/i.test(l) && /our team|so we can|update|take them off|receive (interested agents|those)/i.test(l));
  assert.ok(acts.length >= 6, String(acts.length));
  for (const l of acts) assert.match(l, /ask for a person/i, l);
  assert.match(articleText(articleBySlug("replying-to-an-interested-agent")!), /Hit reply all on that email/);
  assert.doesNotMatch(articleText(articleBySlug("moving-agents-between-stages")!), /only move forward/);
});
