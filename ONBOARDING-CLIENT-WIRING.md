# Onboarding — the client detail page: wiring

The four screens are built, tested and reachable from the pipeline. What is
missing is their address, and that lives in one file this task was not allowed
to edit:

    src/app/[[...slug]]/page.tsx

`src/lib/workspace/nav.ts` needs **no change**, and neither does the rail. This
is a DETAIL route under an existing destination, exactly like
`/inbox/portals/<clientId>` — the precedent Master Inbox already set.

---

## Why no new nav id

`idForPath("/onboarding/clients/<uuid>")` already returns `onboarding:pipeline`:
`clients` is not one of Onboarding's four leaf ids, and the function falls back
to the product's first child rather than to Home. So all four addresses —

    /onboarding/clients/<id>
    /onboarding/clients/<id>/leads
    /onboarding/clients/<id>/agents
    /onboarding/clients/<id>/team

— resolve to the destination the rail already highlights. The rail keeps
"Pipeline" lit while you are inside a client, which is correct: you are still in
the pipeline, looking at one row of it.

---

## Three edits, all in `src/app/[[...slug]]/page.tsx`

### 1. Imports

Beside the existing `OnboardingPipelineScreen` import:

```ts
import { getClientDetail } from "@/lib/tools/onboarding/client-detail";
import { OnboardingClientScreen, type ClientTab } from "@/components/screens/onboarding/client";
```

### 2. A helper, beside `threadIdFrom`

```ts
/** The client id in /onboarding/clients/<uuid>[/tab], or null. */
function onboardingClientFrom(slug: string[] | undefined): { id: string; tab: ClientTab } | null {
  const parts = slug ?? [];
  if (parts[0] !== "onboarding" || parts[1] !== "clients") return null;
  const id = parts[2];
  if (!id || !UUID.test(id)) return null;
  const t = parts[3];
  const tab = t === "leads" || t === "agents" || t === "team" ? t : "profile";
  return { id, tab };
}
```

`UUID` is already defined in that file. The guard is deliberately the same shape
as `threadIdFrom`'s: check that the URL really is this screen's, not merely that
it ends in a uuid. Every screen renders on every request, and the last time one
assumed otherwise it 404'd the whole page.

### 3. The server-side load, and the registry

Above the `Promise.all`, beside `const only = (id: string) => ...`:

```ts
  const onbClient = onboardingClientFrom(slug);
```

Then one new entry in the `Promise.all`. **Order matters** — the destructured
names are positional, so the new name and the new promise must sit in the same
place. Put both immediately after `onboarding`:

```ts
  const [snapshots, overview, performance, clientHealth, clientsOverview,
         onboarding, onboardingClient, onboardingStages, /* …unchanged… */] =
    await Promise.all([
      …
      only("onboarding:pipeline") ? getOnboardingPipeline() : Promise.resolve(null),
      // Not gated on `only(...)`: `onbClient` is already null unless the URL
      // really is a client, which is a stricter test than the destination id.
      onbClient ? getClientDetail(onbClient.id) : Promise.resolve(null),
      …
    ]);
```

Finally, in `pick({ … })`, replace the `"onboarding:pipeline"` entry with:

```tsx
        /*
         * /onboarding is the board; /onboarding/clients/<id> is one client.
         * Same shape as inbox:portals — the id decides which screen, and the
         * check is "is this URL really a client?", not "does it end in a uuid".
         */
        "onboarding:pipeline": onbClient ? (
          <OnboardingClientScreen
            clientId={onbClient.id}
            tab={onbClient.tab}
            initial={onboardingClient}
          />
        ) : (
          <OnboardingPipelineScreen initial={onboarding} />
        ),
```

`initial` may be `null` — the screen fetches its own route on mount and shares
one request through `loadOnce`, so a wrong guess costs a round trip, never a
blank screen. A client id that does not exist renders the screen's own "that
client could not be loaded" ribbon with a link back to the pipeline, because the
route answers 404 rather than an empty profile.

---

## Addresses this produces

| Address | Renders | API behind it |
|---|---|---|
| `/onboarding` | the pipeline, unchanged | `GET /api/tools/onboarding` |
| `/onboarding/clients/<id>` | Profile | `GET,PATCH /api/tools/onboarding/clients/<id>` |
| `/onboarding/clients/<id>/leads` | Lead list | `GET …/clients/<id>/leads` |
| `/onboarding/clients/<id>/agents` | Their agents + DNC | (in the client payload) |
| `/onboarding/clients/<id>/team` | Team | (in the client payload) |

Plus, used by the screen:

| Route | Method | What it does |
|---|---|---|
| `…/clients/<id>/fields` | POST | add a custom field |
| `…/clients/<id>/fields/<fieldId>` | PATCH, DELETE | edit / reorder / delete one |
| `…/clients/<id>/steps` | POST | **validates a step and refuses it** |
| `…/mls?q=` | GET | MLS type-ahead (reads Agent Search's `mls`) |

The pipeline table already links at these: every client name in
`components/screens/onboarding/pipeline.tsx` is now an `<a href>` to
`/onboarding/clients/<id>`. Until the three edits above land, those links resolve
to the pipeline itself — a harmless no-op, not a 404.

---

## Tab navigation, once wired

The tab strip changes the tab in React state and the address with
`history.pushState`, the same choice the shell makes for warm panes: the screen
is already mounted and holding its payload, so asking the server again would
only rebuild what is on screen. A fresh load of any of the four addresses starts
on the right tab because the `tab` prop says so, and `popstate` is handled, so
the back button walks the tabs.

---

## Running the tests before wiring

Three scripts, all defaulting to `localhost:3340` / CDP `9447`:

```
node scripts/onboarding-client-write-test.mjs     # 68 checks, no browser
node scripts/onboarding-client-ui-test.mjs        # 37 checks, real Chrome
node scripts/onboarding-client-layout-test.mjs    # 4 tabs × 3 widths
```

The write test needs no address — it drives the API directly. The other two need
one, and an unwired screen has none, so they take a prefix:

```
ONBOARDING_CLIENT_PREFIX=/onboarding/clients node scripts/onboarding-client-ui-test.mjs
```

after wiring. Before it, they default to `/onboarding-client-preview`, a
temporary harness that has been **deleted**. It was one file — recreate it at
`src/app/onboarding-client-preview/[...path]/page.tsx` to test before wiring:

```tsx
import { getClientDetail } from "@/lib/tools/onboarding/client-detail";
import { OnboardingClientScreen, type ClientTab } from "@/components/screens/onboarding/client";

export const dynamic = "force-dynamic";
const TABS = new Set(["leads", "agents", "team"]);

export default async function Preview({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const clientId = path[0];
  const tab = (path[1] && TABS.has(path[1]) ? path[1] : "profile") as ClientTab;
  const initial = await getClientDetail(clientId);
  return (
    <div className="app">
      {/* `.app` is a two-column grid; without an empty rail the stage lands in
          the 264px rail column and every width measured here would be wrong. */}
      <aside className="rail" />
      <div className="stage">
        <div className="scroll">
          <section className="screen on">
            <OnboardingClientScreen clientId={clientId} tab={tab} initial={initial} />
          </section>
        </div>
      </div>
    </div>
  );
}
```

---

## The fourteen step buttons — what is wired and what is not

**All fourteen are on the screen, none of them fires.** This is the single most
important thing to understand before touching this code.

Each button posts to `POST /api/tools/onboarding/clients/<id>/steps`, which:

1. rejects a step key not in the catalogue (**400**), before anything is read;
2. rejects an unknown client (**404**);
3. runs the step's own preconditions — the same ones the live action runs, down
   to the once-only `hasDelivery` guard on the welcome email — and refuses with
   the live action's own sentence (**400**);
4. otherwise logs one line to the server console naming the client, the step,
   the service and the effect, and answers **501** with a body that says which
   service would have been called, what that call does, whether it is
   reversible, and which credential the workspace lacks.

There is no 200. `planStep` has no success branch to reach.

`src/lib/tools/onboarding/step-effects.ts` is the catalogue of effects, and
`src/lib/tools/onboarding/client-page.test.ts` asserts that **every** step in
`steps.ts` has an entry — so a step added later cannot become a button whose
blast radius nobody wrote down.

### To enable one, in order

1. the credential for that service in the workspace's environment;
2. a connector module, ported from the orchestrator's `lib/connectors/*`,
   `lib/email.ts` or `lib/stripe.ts`;
3. a row written to `orch_connector_deliveries` on **both** success and failure —
   that table is what `step-state.ts` reads to draw the ✓, and a send that does
   not log is a send that will be made twice;
4. the tool's own once-only guards, which are the reason a double click has never
   yet sent a client two welcome emails.

Do them in that order, one step at a time, and never `campaign:launch` first.

---

## What this port deliberately does NOT carry

**The setup automation chain.** The tool's "Mark approved" calls
`runSetupAutomation` when the master switch is on: portal → four emails → team →
Health Dash → campaign. One click, six external side effects. The OS's copy
approval writes the flag and stops. The button on screen says so.

**`syncBisonImports()` on page view.** The tool calls EmailBison on every single
view of a client page to refresh the "leads imported" flag. Opening a client here
makes no hub call at all; the live orchestrator's `/api/cron/check-bison-imports`
keeps that flag current, as it always has.

**`orch_clients.status`, except in one direction.** It is the automation's own
bookkeeping and decides which clients its intake-email sweep considers. Nothing
here writes it except copy approval, which sets `copy_approved` — the one
direction that takes a client OUT of that pool.
