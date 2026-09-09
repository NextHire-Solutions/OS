# Master Inbox — audit before rebuilding it in the workspace

55,881 lines across 297 files, 76 migrations. This records what the code
actually does, because the workspace is going to become the staff inbox and
`portal.brokerstaffer.com` must keep serving live client portals throughout.

Everything below was read from the source, not inferred. Where a number appears
it was counted.

---

## 1. The one thing that must not break

Client portals are served by **the same Next application** as the staff inbox.
They are separated by hostname, in `proxy.ts`, before authentication runs:

```ts
const PORTAL_HOSTS = new Set(["portal.brokerstaffer.com"]);
if (PORTAL_HOSTS.has(host)) {
  // only /portal, /api/portal, /api/metrics, /_next, /favicon,
  // /portal-logo, /portal-locked survive.
  // everything else REWRITES to /portal-locked — the URL bar never
  // changes, and the staff app is never reachable from this host.
}
```

The rewrite (rather than a redirect) is deliberate and is documented in the
file: an earlier version 302'd to the Railway URL, which leaked the staff app
to anyone who hit `portal.brokerstaffer.com/`.

**Consequence for us:** the workspace is a different app on a different host. It
never runs that code, never deploys to that service, never touches that env.
The gate cannot be affected by anything we build.

**The real exposure is the database**, which both share. That is the rest of
this document.

### Discontinuing the staff app is not an option as stated

The webhooks, the portals and the staff app are one deployment. Shutting it
down takes the portals and the inbound mail with it. The workable end state is
the one already used for the other tools:

> the Master Inbox **service** stays deployed — it hosts the portals, receives
> the webhooks, and owns the write path. Nobody opens its staff UI, because the
> workspace is the staff UI.

---

## 2. How a portal authenticates

`lib/portals/token.ts` — the token in the URL *is* the credential. It resolves
through a **service-role** client, so portals bypass RLS exactly as the
workspace will.

A portal resolves only when all of these hold:

| condition | column |
|---|---|
| the token matches | `clients.portal_token` |
| the portal is enabled | `clients.portal_enabled != false` |
| it is not the fallback row | `clients.slug != 'unknown'` |
| the feature flag is on | `CLIENT_PORTALS_ENABLED` |

**So the complete list of writes that would break a live portal is:**

1. changing or clearing `clients.portal_token`
2. setting `clients.portal_enabled = false`
3. setting `clients.slug = 'unknown'`
4. deleting the `clients` row

That is the whole list. It is short, it is specific, and none of it is anything
a staff inbox needs to do.

---

## 3. Which tables both sides touch

Counted by walking every `.from("…")` in the tree and classifying the file.
`r` = read sites, `w` = write sites.

| table | portal | staff | background |
|---|---|---|---|
| **`client_pipeline_entries`** | 6r **9w** | 18r **8w** | · |
| **`clients`** | **4w** | 20r **4w** | · |
| **`client_team_members`** | 4r **10w** | 2r | · |
| **`client_agents`** | 1r **7w** | 1r | · |
| **`client_dnc_entries`** | 1r **7w** | 1r | · |
| **`client_pipeline_notes`** | 1r **3w** | 3r **1w** | · |
| **`client_pipeline_stages`** | 2r **2w** | 1r | · |
| **`messages`** | 1r | 18r **8w** | 13r **6w** |
| `threads` | · | 44r **18w** | 10r **3w** |
| `label_assignments` | · | 14r **10w** | 1r |
| `leads`, `lists`, `labels`, `reminders`, … | · | staff only | · |

Eight tables are shared. **Five are written by both sides.**

`client_pipeline_entries` is the one to be careful with: both sides write it
heavily, and it is the table the client sees.

---

## 4. Writes have database-side consequences

Four triggers on the pipeline, from migrations 0023 and 0027:

```
client_pipeline_intro_label_trigger      labelling a thread CREATES a pipeline row
client_pipeline_external_intro_trigger   an external intro CREATES a pipeline row
client_pipeline_set_hired_at
client_pipeline_notes_touch_entry
```

Read that first line again, because it is the single most important fact in
this document:

> **A staff member applying a label in the workspace creates a row that appears
> in that client's live portal.**

The coupling is bidirectional — pipeline rows trace back to `external_intros`
via `external_intro_id`, deduped by `(client_id, thread_id)` and by
`(client_id, external_intro_id)`. Those same intro counts feed Client Health
and the workspace roster.

So a wrong label write in the workspace is not a display bug. It is a row a
client sees, and a number three other screens report.

**This is the argument for routing every write through Master Inbox's own API
rather than writing its tables from the workspace.** The triggers fire either
way, but the columns they depend on are set correctly only by the code that
already knows about them.

---

## 5. Sending a reply

`app/api/threads/[threadId]/reply/route.ts` — **715 lines**, and it sends real
email to real agents. It:

- resolves the thread's `source_provider` (Instantly or EmailBison)
- resolves a sender override into provider-specific identifiers
  (`emailbison_sender_email_id`, `instantly_account_id`, `emailbison_team_id`)
- falls back to the thread's `outbound_sender_email`, then to the channel row
- calls the matching provider client
- records the message and updates the thread

Two provider clients, `lib/instantly/client.ts` and
`lib/emailbison/client.ts`, sit behind it.

**Do not reimplement this.** A divergence here does not throw an error — it
sends an email from the wrong address, or to the wrong thread, and the first
person to notice is the recipient.

---

## 6. Inbound

Three webhook receivers: `/api/webhooks/instantly`, `/api/webhooks/emailbison`,
`/api/webhooks/register`. They are exempted from the auth gate in `proxy.ts`
and carry their own provider-token checks.

They must keep answering **on their current URLs**. Providers hold those URLs;
moving them means re-registering with two vendors and losing whatever arrives
in between.

---

## 7. Scale and RLS

| | |
|---|---|
| workspaces | **1** |
| workspace members | 2 |
| clients | 58 |
| threads | 10,064 |
| messages | 35,765 |
| labels | 21 |
| tables with RLS | 27, 23 policies |

Multi-tenancy is nominal — there is one workspace. The workspace will still
scope every query by `workspace_id` explicitly rather than rely on that
remaining true.

**RLS is not the obstacle the earlier plan assumed.** That plan embedded the
tool and replaced its session, so a wrong cookie meant every query silently
returned zero rows. Building natively means the 51 RLS-bound files never run.
The workspace reads with the service-role key — the same key the portals
already use — and does its own authorisation, exactly as it now does for Client
Health, Analytics and Agent Search.

The credential is already in hand: `MASTER_INBOX_ADMIN_TOKEN` decodes to
`role: service_role`, `ref: dukbececdyowowwyktys`. No new secret is needed.

At 10k threads and 36k messages every list is server-paged, as Agent Search is.

---

## 8. What actually has to be rebuilt

`components/` is 24,949 lines, but **11,028 of them are the portal UI**, which
stays on the live service. The staff surface is much smaller:

| area | lines | rebuild? |
|---|---|---|
| `components/inbox` | 8,173 | yes |
| `components/settings` | 3,213 | yes |
| `components/portals/pipeline-board.tsx` | 3,001 | yes — shared with the portal |
| `components/layout` | 759 | no — the workspace has its own shell |
| `components/ui` | 1,588 | mostly no — our design supplies these |
| `components/auth` | 144 | no — one workspace login already |
| rest of `components/portals` | ~8,000 | **no — client-facing, stays** |

So roughly **14,000 lines** of UI, not 25,000. The largest single pieces are
`composer.tsx` (1,528), `prospect-panel.tsx` (960), `filter-builder.tsx` (921)
and `thread-view.tsx` (918).

`pipeline-board.tsx` is imported by both `app/portal/[token]/page.tsx` and
`app/(app)/portals/[clientId]/page.tsx` — the client sees it and staff see it.
Rebuilding the staff half must not change the shared table's shape.

---

## 9. Rules this audit produces

1. **Never write Master Inbox's tables directly.** Every write goes through its
   own API, so its validation and the trigger contracts hold.
2. **Reads may go straight to the database** with the service-role key, using
   copied query code, page by page.
3. **Never touch** `portal_token`, `portal_enabled`, `slug`, or delete a client.
4. **Treat labelling as a client-visible action**, because it is — it creates a
   pipeline row in a live portal.
5. **Do not reimplement the reply route.** Call it.
6. **Leave the service deployed.** It is the portal host, the webhook receiver
   and the write path, whatever happens to its staff UI.
7. Scope every query by `workspace_id`, even with one workspace.
