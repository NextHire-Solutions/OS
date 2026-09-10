# Master Inbox in the OS — how it is built, and what it cost

The staff inbox in this workspace is **the tool's own code**, not a
reimplementation. This file explains the shape of that, the small number of
places where it could not stay identical, and the bugs the port exposed.

## Why copied rather than rebuilt

A hand-written inbox against the mockup's stylesheet reached a screen that
looked right and was missing most of the product: no attachments, forward,
reply-all, template picker, sender picker, AI draft, snooze, prospect panel or
filter builder. Each of those is a component that already exists, already works
and is already trusted. Rediscovering them one by one was the expensive path and
the one most likely to lose something quietly.

So: 36 components, 38 API routes, 14 loaders and 8 settings pages copied across.

## What makes copied code run here unmodified

A shim layer at the import paths the original already uses:

| the original imports | it gets |
|---|---|
| `@/lib/supabase/server` | the service-role client, with an `auth.getUser()` adapter |
| `@/lib/supabase/admin` | the same client (it was service-role there too) |
| `@/lib/auth/workspace` | `requireSession()` answered from the OS's own session |
| `@/lib/env`, `@/lib/cache/ttl`, `@/lib/inbox/*` | re-exports of the OS's copies |

The point of the shims is that the components stay **byte-identical to the
tool's**, so the next copy needs no edits and a diff against the original stays
readable.

## The three places behaviour genuinely differs

**RLS is gone.** The tool queries as the signed-in user and RLS filters by
workspace. Here queries run as service-role and are scoped by an explicit
`.eq("workspace_id", …)`. Safe because the deployment is single-tenant and
`workspaceId()` throws if a second workspace ever appears — it stops rather than
leaks.

**`user.id` is null.** OS users have no `auth.users` row, so a fabricated UUID
would violate the four foreign keys that field feeds. All four columns are
nullable and the tool already stores null in most of them (176 of 200 label
assignments, 25 of 55 lists, 11 of 15 custom views), so rows written here are
indistinguishable from the tool's. The cost is per-user attribution on those
columns, which nothing currently reads.

**Realtime became a poll.** Supabase Realtime filters `postgres_changes` through
the same RLS. With no user session it would subscribe successfully and deliver
nothing forever — a failure that looks like success. The tool's own 30-second
poll, which it carries as a safety net, is the mechanism here.

## What is deliberately NOT here

`/api/portal/*`, `/api/webhooks/*`, `/api/cron/*` and the admin backfills were
excluded from the copy. The live service keeps serving client portals, receiving
provider webhooks and running crons; a second copy of those would double-process
webhooks and put a second writer on the portal tables.

## Bugs the port exposed

Each of these would have shipped silently.

1. **23 route files returned 401 to everyone.** They gate on
   `supabase.auth.getUser()`, which can never succeed against a service-role
   client. Fixed once, in the shim.
2. **Every Tailwind utility was being overridden.** `workspace.css` was imported
   unlayered, and unlayered CSS beats layered CSS regardless of specificity, so
   `*{margin:0;padding:0}` beat all 308 utility classes in the copied
   components. Fixed by declaring
   `@layer theme, base, components, mockup, utilities`.
3. **45 inherited `dark:` classes fired on dark-mode machines**, producing a
   light page with unreadable dark rows. `dark:` is now class-based, not
   OS-preference-based.
4. **`--accent` was never defined** while `bg-accent` is used 26 times — every
   hover and selected state painted transparent.
5. **React #418 on every thread open**, and not from a date: `@dnd-kit` derives
   `aria-describedby` from a global counter, and this shell mounts ten screens,
   so server and client disagreed. Fixed with a stable `id`.
6. **Timestamps rendered in the viewer's locale** — `Tue, Sep 8, 8:20 PM` on the
   server, `Tue 8 Sept, 20:20` in an en-GB browser. Now explicitly `en-US` /
   `America/New_York`, which is also the correct time for this team.

## Portal safety

The copied client editor can write `portal_token` and delete clients — the tool
administers portals, so its code does too. Two guards were added:

- `portal_token` is frozen on an **existing** client (creating one still mints a
  token, and renaming still derives a slug — neither changes a live URL).
- Deleting a client that has a live portal is refused.

`scripts/portal-fingerprint.mjs` records every client's token, enabled flag and
slug plus row counts on the eight portal-backing tables, and reports any change.

## Running the checks

```
./scripts/verify.sh          # typecheck, unit, API, screens, features, payload, portals
node scripts/portal-fingerprint.mjs save|check
node scripts/shot.mjs /inbox/all-email out.png
```

`verify.sh` runs on port 3210 and **refuses to kill a process it does not own** —
it previously used 3111, which is the Analytics Dashboard's dev port, and killed
it repeatedly.

---

# The inbox ↔ portal flows, and how each is tested

Three connections run between the staff inbox and the client portals. **None of
them is application code** — all three are database triggers, which is why
grepping the portal's route handlers for `label_assignments` finds nothing and
why one of them was missed on the first pass.

The rule that follows from that: *enumerate the triggers that WRITE a table, not
only the ones defined on it.*

| # | direction | mechanism | what it does |
|---|---|---|---|
| 1 | inbox → portal | `client_pipeline_intro_label_trigger` (0023) | labelling a thread "Introduction" creates a pipeline entry in that client's portal |
| 2 | inbox → portal | `client_pipeline_cleanup_on_unlabel` (0033) | clearing every label removes the entry again |
| 3 | **portal → inbox** | `pipeline_apply_no_show_label` (0070) | a client moving someone to "No Show / No Response" writes that label back onto the thread |

## 1 — Introduction creates the portal entry

`node scripts/demo-portal-test.mjs`

Labels the test thread through the OS route, then reads the **live portal** — a
different deployment — to confirm the person appears. Passing means the OS's
writes reach a customer's screen.

Fires n8n and Slack, which cannot be undone. That is why it is not in
`verify.sh`.

## 2 — Unlabelling removes them again

`node scripts/unlabel-cascade-test.mjs`

The subtlety is in 0033's comment: the label picker performs a swap as
DELETE-then-INSERT, so a plain `AFTER DELETE` trigger would see "no labels left"
in the gap and bin a live pipeline row. It is a CONSTRAINT TRIGGER, DEFERRABLE
INITIALLY DEFERRED, so it judges the state at commit.

Both failure modes are silent and opposite — too eager deletes rows mid-swap,
too lax leaves strangers in a customer's portal. The migration exists because
the second one happened: a test thread for sankalp@outreachify.io kept showing
in Front Range Collective's portal after its labels were cleared.

## 3 — A portal stage change writes back to the inbox

`node scripts/reverse-flow-test.mjs`

**Run against "Test FUB", not the demo client.** Migration 0070 hardcodes an
exclusion for the demo client id (`00ef116c-…`), so the demo portal cannot
exercise this flow at all — a test using it would pass by doing nothing.

The script sets `client_pipeline_entries.stage` directly, which is what the
portal's `PATCH /api/portal/<token>/pipeline/<id>` ultimately does, and the
trigger is an `AFTER UPDATE` on that table either way. Driving the live portal's
HTTP endpoint would mean issuing a write to a production service serving 47
customers; that is a separate and louder decision.

## Which client to test against

| client | use it for | why |
|---|---|---|
| **Demo Portal** | flows 1 and 2 | exists to be experimented with; no FUB key |
| **Test FUB** | flow 3 | not a real customer, and **not** 0070's excluded id |
| anyone else | never | a real customer would see the row while it existed |

Every one of these scripts records the prior state, asserts the change, and puts
it back — then re-reads the counts and says plainly whether the restore worked.
Run `node scripts/portal-fingerprint.mjs check` afterwards; `client_pipeline_entries`
and `label_assignments` should both read "unchanged".
