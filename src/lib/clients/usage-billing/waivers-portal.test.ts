import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * The user, 6 Nov: "we should not have an option as dont bill inside client portal as client can click on dont bill
 * button". The button lives on the OS client record's Billing tab only. This pins that nothing the client portal is
 * built from names it, its route or its table — and that the route answers only the Billing tab's named people.
 */

const ROOT = join(import.meta.dirname, "../../../..");
const PORTAL_CODE = ["src/components/crm-preview", "src/lib/crm-preview", "src/app/api/crm-preview", "src/app/crm-preview", "src/app/portal-signin", "src/app/api/portal-signin"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("nothing the client portal is built from can show or reach Don't bill", () => {
  const all = PORTAL_CODE.flatMap((d) => files(join(ROOT, d)));
  assert.ok(all.length > 20, "the portal's code was found");
  for (const f of all) {
    const text = readFileSync(f, "utf8");
    for (const word of [/Don(&apos;|')t bill/i, /\bwaive/i, /os_usage_billing_waivers/, /billing\/usage/, /client-usage-billing/, /UsageBillingPanel/]) {
      assert.doesNotMatch(text, word, `${f.slice(ROOT.length + 1)} mentions ${word}`);
    }
  }
});

test("the route answers only the Billing tab's named people, on every request, before anything else", () => {
  const route = readFileSync(join(ROOT, "src/app/api/workspace/clients/billing/usage/route.ts"), "utf8");
  const handlers = route.split(/export async function (?=GET|POST)/).slice(1);
  assert.equal(handlers.length, 2);
  for (const h of handlers) assert.match(h, /^\w+\(request: Request\) \{\n {2}const who = await billingTabUser\(request\);\n {2}if \(who instanceof NextResponse\) return who;/);
  const user = readFileSync(join(ROOT, "src/lib/clients/billing-user.ts"), "utf8");
  assert.match(user, /if \(!s\?\.email \|\| !canSeeBillingTab\(s\.email\)\) return new NextResponse\(null, \{ status: 404 \}\);/);
});
