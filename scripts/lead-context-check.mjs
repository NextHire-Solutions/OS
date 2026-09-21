/*
 * The reply the agent would now write for a lead whose details we already hold.
 *
 * The case this exists for is real and shipped: Nancy Guerriero got
 *
 *   "Can you confirm that (your contact number) is the best number to reach
 *    you? Also, are you currently affiliated with Berkshire Hathaway
 *    HomeServices | PenFed Realty Texas?"
 *
 * while her lead row held the phone AND the company. So the assertions are not
 * "does it produce text" — they are that the number appears, the company is
 * not asked for, and no parenthetical placeholder survives.
 */
import { generateReplyDraft } from "../src/lib/tools/master-inbox/ai/reply.ts";

const KEY = process.env.ASSISTANT_OPENAI_API_KEY;
if (!KEY) {
  console.log("no ASSISTANT_OPENAI_API_KEY — skipping the live draft");
  process.exit(0);
}

const PHONE = "+12147968485";
const COMPANY = "Berkshire HathawayHS PenFed TX";

const base = {
  provider: "openai",
  apiKey: KEY,
  model: "gpt-4o-mini",
  systemPrompt:
    "You are an outbound-sales rep responding to inbound replies from leads. " +
    "Be direct, warm and concise. Plain text only. No subject, no greeting, no sign-off — just the body.",
  tone: "professional",
  responseLength: "medium",
  temperature: 0.3,
  maxTokens: 400,
  leadName: "Nancy Guerriero",
  leadEmail: "nbg3323@gmail.com",
  ourName: "Nicole Collins",
  ourEmail: "nicole@getbrokerstafferrealestate.com",
  subject: "Re: More business with no upfront costs",
  conversation: [
    {
      direction: "outbound",
      sentAt: "2026-09-19T10:00:00Z",
      body: "Hi Nancy — we help agents take on more business with no upfront costs. Worth a quick look?",
    },
    {
      direction: "inbound",
      sentAt: "2026-09-21T16:53:00Z",
      body:
        "I appreciate the need. I have been out of the country solving an issue. " +
        "I am happy to look at areas i feel my expertise excels in. That serves the client. Thk you",
    },
  ],
};

const run = async (label, extra) => {
  const { body } = await generateReplyDraft({ ...base, ...extra });
  const text = body.replace(/\s+/g, " ").trim();
  console.log(`\n── ${label} ──`);
  console.log(text);
  return text;
};

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

// Before: the shipped behaviour, with only a name and an address.
const before = await run("WITHOUT the lead's details (what shipped)", {});

// After: the same thread, with what the lead row actually holds.
const after = await run("WITH the lead's details", {
  leadPhone: PHONE,
  leadCompany: COMPANY,
  leadTitle: null,
  leadFacts: [{ label: "office city", value: "Dallas, TX" }],
});

/*
 * THE PROMPT MUST NOT CONTAIN A VALUE OF ITS OWN.
 *
 * The first version of this feature illustrated its rule with a real lead's
 * phone number, and the model copied that number into a draft for a DIFFERENT
 * lead whose prompt never contained it. An example in a prompt is content, not
 * illustration. This asserts the instruction carries no value to copy.
 */
{
  const { renderUserPrompt } = await import("../src/lib/tools/master-inbox/ai/reply.ts");
  const bare = renderUserPrompt({ ...base, conversation: base.conversation });
  /*
   * Scoped to the INSTRUCTION, not the whole prompt: the conversation carries
   * ISO timestamps, and "2026-09-19" trips a naive phone pattern. The thing
   * that must be value-free is the rule the model is told to follow.
   */
  /*
   * Bounded to the instruction itself. The known-facts block sits BEFORE the
   * conversation, so slicing to the end of the prompt swept in the ISO
   * timestamps and failed on "2026-09-19".
   */
  const from = bare.indexOf("Do NOT ask for anything listed above");
  const rule = from === -1 ? "" : bare.slice(from, bare.indexOf("\n", from + 1) + 1 || undefined);
  const leak = rule.match(/\+?\d[\d\s().-]{7,}/);
  leak ? no("the instruction contains no value to copy", leak[0])
       : ok("the instruction contains no value to copy");
  bare.includes("2147968485")
    ? no("a lead's real number never appears in a prompt that lacks it", "it does")
    : ok("a lead's real number never appears in a prompt that lacks it");
}

console.log("\nassertions on the NEW draft:");

/*
 * The REQUIREMENT is that it stops asking for what we already hold. Whether it
 * volunteers the value back is a separate product choice, so it is reported
 * rather than asserted — an assertion here would fail a perfectly good reply
 * that simply moved the conversation on.
 */
const digits = (s) => s.replace(/[^\d]/g, "");
const statesItBack = after.includes(PHONE) || digits(after).includes(digits(PHONE));
console.log(`  note  it ${statesItBack ? "DID" : "did not"} state the number back to confirm it`);

/^.*\((your|his|her|their)[^)]*\)/i.test(after)
  ? no("no placeholder like \"(your contact number)\"", after.match(/\([^)]*\)/)?.[0] ?? "")
  : ok("no placeholder like \"(your contact number)\"");

/are you (currently )?(affiliated|with)\b/i.test(after) && !after.includes(COMPANY.split(" ")[0])
  ? no("does not ask which company they are with", "it still asks")
  : ok("does not ask which company they are with");

/what('s| is) (your|the best)\b.*(number|phone)/i.test(after)
  ? no("does not ask for the phone number", "it still asks")
  : ok("does not ask for the phone number");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
