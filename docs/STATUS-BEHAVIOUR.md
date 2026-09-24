# What each client status actually does

The architecture spec closes §9 with one line that nothing else in it expands:

> The exact operational behavior of each status needs to be defined for every
> connected system.

And §11 asks for "status behavior" to be standardised alongside the names and
colours. This is that definition. Every row is either **implemented** — in
which case it says where — or **undecided**, in which case it says so rather
than implying a rule that does not exist.

Written 2026-09-24. The four statuses and their meanings are §9's:

| Status | §9's definition |
|---|---|
| **Onboarding** | Client has been created and is going through the onboarding process |
| **Active** | Client is currently active and receiving the service |
| **Paused** | Client is temporarily paused but **remains a client** |
| **Churned** | Client is no longer an active client |

---

## Client portal

| Status | Behaviour | State |
|---|---|---|
| Onboarding | **Left exactly as it is.** Not opened, not closed. | ✅ implemented |
| Active | Portal **open** | ✅ implemented |
| Paused | Portal **closed** | ✅ implemented |
| Churned | Portal **closed** | ✅ implemented |

Onboarding is the one that needed a decision rather than an implementation. A
client being set up is neither running nor stopped, and a portal is often
opened deliberately during setup so they can look at it. So the feed **omits**
onboarding clients entirely and Master Inbox never touches a client it cannot
see. Treating onboarding as "not active" would have shut those portals.

The switch is `master_inbox.clients.portal_enabled`. The portal **token** is
never changed by any status: a churned client's URL still exists, it simply
refuses to open, so reactivating restores the same address.

Two paths drive it, deliberately: a status set in the OS propagates
Client Health → Analytics → portal, and a status set directly in Client Health
still propagates on its own. The standalone tools are not being switched off.

---

## Client Health

| Status | Behaviour | State |
|---|---|---|
| Onboarding | `hidden` false, `client_paused` false | ✅ implemented |
| Active | `hidden` false, `client_paused` false | ✅ implemented |
| Paused | `client_paused` true | ✅ implemented |
| Churned | `hidden` true | ✅ implemented |

A database trigger keeps `status` and the two booleans in step in **both**
directions (migration 0019), so the tool's own screens — which only know the
booleans — keep working unchanged, and neither can be left stale.

`onboarding` and `active` are indistinguishable here, because two booleans
cannot express four states. `status` is the column that can.

---

## Analytics

| Status | Behaviour | State |
|---|---|---|
| Onboarding | `active` false | ✅ implemented |
| Active | `active` true | ✅ implemented |
| Paused | `active` false | ✅ implemented |
| Churned | `active` false | ✅ implemented |

A trigger derives the boolean from the status (migration 092/093). Campaign
history is never deleted — a paused client's attribution survives, which is
what makes reactivation possible.

---

## Master Inbox

| Status | Behaviour | State |
|---|---|---|
| any | `clients.status` is recorded and **nothing reads it** | ⚠️ mirror only |

Migration 0001 added the column deliberately "recorded but not yet enforced".
Nothing in that app reads it, and the OS cannot write it — `os-db.ts` refuses
every Master Inbox table because that one holds the live portal tokens.
Keeping it current belongs to Master Inbox's own reconcile, which already
reads the status feed to set `portal_enabled`.

Until then the Consistency screen reports a difference there as an explained
lag rather than a decision anyone can act on.

---

## Campaigns — **UNDECIDED**

| Status | What should happen? |
|---|---|
| Paused | Pause the client's EmailBison / Instantly campaigns? |
| Churned | Pause them? Archive them? Leave them? |

**Nothing happens today.** A churned client's campaigns keep running unless
somebody pauses them by hand.

This is the largest open question in the document, because it is the one where
doing nothing costs money and sends mail on behalf of a client who has left.
§21 steps 8 and 9 say "every relevant system reflects the paused state" without
saying whether campaigns are one of them.

Related and separate: `connector-bison.ts` pauses a campaign once the week's
introductions reach the client's weekly target. That is a *volume* rule, not a
lifecycle one, and it reads `orch_clients.weekly_target` — which is the number
3 for all 46 rows. Worth checking on its own.

---

## Billing — **UNDECIDED**

| Status | What should happen? |
|---|---|
| Paused | Stop charging? Keep the anchor date and resume? |
| Churned | Cancel the Stripe subscription? |

**Nothing happens today.** §22 requires "Stripe is connected to the correct
client record", and it is not: Stripe lives on `orch_clients` and only for
clients that came through Typeform intake.

Deliberately left alone. Billing is the one place where an automated reaction
to a status is worse than a manual one — a wrong churn flag that cancels a
subscription is not recoverable by flipping the flag back.

---

## Onboarding tool — **not applicable, by design**

`orch_clients.status` is a **pipeline**, not a lifecycle:

    new → assigned → copy_sent → copy_approved → team_built → leads_built
        → campaign_launched → live → paused

It answers "how far through onboarding is this client", not "is this client
active". The two share the word *paused* and mean different things by it.
Folding one into the other would destroy the onboarding board, so the pipeline
keeps its own vocabulary and the OS maps it rather than overwriting it.

Nothing ever creates a client in that tool from outside; the flow runs the
other way, and a client it creates is adopted into the master list.

---

## Database / Scraper — **UNDECIDED**

Whether a churned client's leads should stop being scraped, exported or
enriched has never been defined. The lead tables carry no status at all.

---

## The decisions this leaves

1. **Campaigns on pause and churn** — the one that costs money
2. **Billing on pause and churn** — and connecting Stripe to the master record
3. **The Database/scraper question**
4. Who keeps `master_inbox.clients.status` current

Everything above those four lines is implemented and verified. These four are
business decisions, and writing them down as undecided is more honest than a
rule nobody agreed to.
