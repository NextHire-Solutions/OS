import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Saving a client's own subject goes through the real save and read, against an
// in-memory os_clients row. No database is touched.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const row: Record<string, unknown> = {
  id: "c1", name: "FAST Real Estate", brokerage: "FAST Real Estate",
  contact_name: "Elias Astuto", contact_role: "Director of Sales", contact_email: "e@example.com",
  intro_subject: null, intro_override: null, intro_variants: [], more_contacts: [], contact_territories: {},
};
let columnExists = true;
let readFailure: string | null = null;
const writes: Record<string, unknown>[] = [];

function osTable() {
  let asked = "";
  const noColumn = () => !columnExists && asked.includes("intro_subject");
  const missing = { message: "column os_clients.intro_subject does not exist" };
  const b = {
    select: (c?: string) => { asked = c ?? ""; return b; },
    eq: () => b,
    not: () => b,
    limit: () => b,
    maybeSingle: async () => {
      if (readFailure && asked.includes("intro_subject")) return { data: null, error: { message: readFailure } };
      return noColumn() ? { data: null, error: missing } : { data: row, error: null };
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(res),
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        if (!columnExists && "intro_subject" in patch) return { error: missing };
        writes.push(patch);
        Object.assign(row, patch);
        return { error: null };
      },
    }),
  };
  return b;
}

let saveIntroSubject: typeof import("./intro-override").saveIntroSubject;
let introView: typeof import("./intro-override").introView;
const STANDARD = "Intro: {{lead.first_name}} & FAST Real Estate";

test("setup", { skip }, async () => {
  mock.module("./os-db", { namedExports: { osTable } });
  mock.module("./intro-template-sync", { namedExports: { syncIntroTemplate: async () => "unchanged" } });
  mock.module("../supabase/admin", { namedExports: { createAdminSupabase: () => ({ from: osTable }) } });
  ({ saveIntroSubject, introView } = await import("./intro-override"));
});

test("a client with no subject of its own shows the standard one, editable", { skip }, async () => {
  const v = await introView("c1");
  assert.deepEqual(v.subject, { custom: null, standard: STANDARD, canSave: true });
});

test("the standard subject follows the client's name when the brokerage is blank", { skip }, async () => {
  row.brokerage = "";
  assert.equal((await introView("c1")).subject.standard, STANDARD);
  row.brokerage = "FAST Real Estate";
});

test("saving stores one clean line and shows it back", { skip }, async () => {
  const v = await saveIntroSubject("c1", "  Meet #TEAMFAST,\n {{lead.first_name}} ");
  assert.equal(row.intro_subject, "Meet #TEAMFAST, {{lead.first_name}}");
  assert.equal(v.subject.custom, "Meet #TEAMFAST, {{lead.first_name}}");
  assert.equal(v.subject.standard, STANDARD);
});

test("blank, null, or the standard wording typed back all clear it", { skip }, async () => {
  for (const clear of [null, "", "   ", STANDARD, ` ${STANDARD}  `]) {
    row.intro_subject = "Something";
    const v = await saveIntroSubject("c1", clear);
    assert.equal(row.intro_subject, null, String(clear));
    assert.equal(v.subject.custom, null);
  }
});

test("a field that does not exist is refused and nothing is written", { skip }, async () => {
  row.intro_subject = "Kept";
  writes.length = 0;
  await assert.rejects(() => saveIntroSubject("c1", "Hi {{lead.frist_name}}"), /can't go in the subject: \{\{lead\.frist_name\}\}/);
  assert.equal(writes.length, 0);
  assert.equal(row.intro_subject, "Kept");
});

test("stray braces and the thread's own subject are refused too", { skip }, async () => {
  row.intro_subject = "Kept";
  writes.length = 0;
  for (const bad of ["Hi {{lead.first_name}", "Intro: {lead first name} & FAST", "Fwd {{thread.subject}}"]) {
    await assert.rejects(() => saveIntroSubject("c1", bad), /can't go in the subject/, bad);
  }
  assert.equal(writes.length, 0);
  assert.equal(row.intro_subject, "Kept");
  row.intro_subject = null;
});

test("FAST's subject saves as asked for", { skip }, async () => {
  const v = await saveIntroSubject("c1", "Connecting you with #TEAMFAST | {{lead.name}}");
  assert.equal(v.subject.custom, "Connecting you with #TEAMFAST | {{lead.name}}");
  row.intro_subject = null;
});

test("double spaces in a brokerage: pressing Save untouched is not a custom subject", { skip }, async () => {
  row.brokerage = "FAST  Real   Estate";
  const v = await introView("c1");
  assert.equal(v.subject.standard, STANDARD);
  const saved = await saveIntroSubject("c1", v.subject.standard);
  assert.equal(saved.subject.custom, null);
  row.brokerage = "FAST Real Estate";
});

test("too long is refused and nothing is written", { skip }, async () => {
  writes.length = 0;
  await assert.rejects(() => saveIntroSubject("c1", "x".repeat(201)), /too long \(201 characters; the limit is 200\)/);
  assert.equal(writes.length, 0);
  await saveIntroSubject("c1", "x".repeat(200));
  assert.equal((row.intro_subject as string).length, 200);
  row.intro_subject = null;
});

test("saving a subject never touches the custom introduction", { skip }, async () => {
  row.intro_override = "Hey {{lead.first_name}}, my own words";
  writes.length = 0;
  await saveIntroSubject("c1", "Meet the team");
  assert.deepEqual(Object.keys(writes[0]).sort(), ["intro_subject", "updated_at"]);
  assert.equal(row.intro_override, "Hey {{lead.first_name}}, my own words");
  row.intro_override = null;
  row.intro_subject = null;
});

test("before the migration: the tab still reads, shows standard, not editable; a save says why", { skip }, async () => {
  columnExists = false;
  try {
    const v = await introView("c1");
    assert.deepEqual(v.subject, { custom: null, standard: STANDARD, canSave: false });
    await assert.rejects(() => saveIntroSubject("c1", "Meet the team"), /needs database migration 0048/);
  } finally {
    columnExists = true;
  }
});

test("a failed read is not mistaken for the migration not having run", { skip }, async () => {
  readFailure = "connection reset";
  try {
    await assert.rejects(() => introView("c1"), /connection reset/);
  } finally {
    readFailure = null;
  }
});
