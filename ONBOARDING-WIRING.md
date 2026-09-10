# Onboarding — wiring

Everything the three new screens need is built and tested. What is missing is
their address, and that lives in one file this task was not allowed to edit:

    src/app/[[...slug]]/page.tsx

`src/lib/workspace/nav.ts` needs **no change** — the four leaf ids already exist
(`pipeline`, `stages`, `templates`, `settings`). The moment a key appears in the
`pick({...})` object, `id in screens` becomes true and the shell stops mounting
an iframe pane for that destination on its own.

Three edits, all in `src/app/[[...slug]]/page.tsx`.

---

## 1. Imports

Beside the existing `OnboardingPipelineScreen` import (line 21) and the
`getOnboardingPipeline` import (line 7):

```ts
import { getStagesBoard } from "@/lib/tools/onboarding/stages";
import { getTemplates } from "@/lib/tools/onboarding/templates";
import { getOnboardingSettings } from "@/lib/tools/onboarding/settings-view";
import { OnboardingStagesScreen } from "@/components/screens/onboarding/stages";
import { OnboardingTemplatesScreen } from "@/components/screens/onboarding/templates";
import { OnboardingSettingsScreen } from "@/components/screens/onboarding/settings";
```

## 2. The server-side load

In the `Promise.all` (around line 149), beside the existing onboarding line.
Each loader runs **only** when its own screen is the one being opened, exactly
like every other entry:

```ts
  const [snapshots, overview, performance, clientHealth, clientsOverview, onboarding,
         onboardingStages, onboardingTemplates, onboardingSettings,
         agentSearch, inbox, reminders, inboxSettings, portals] =
    await Promise.all([
      …
      only("onboarding:pipeline") ? getOnboardingPipeline() : Promise.resolve(null),
      only("onboarding:stages") ? getStagesBoard() : Promise.resolve(null),
      only("onboarding:templates") ? getTemplates() : Promise.resolve(null),
      only("onboarding:settings") ? getOnboardingSettings() : Promise.resolve(null),
      …
    ]);
```

Order matters — the destructured names are positional, so the three new entries
must sit in the array in the same order as the three new names.

## 3. The registry

In `pick({ … })`, beside `"onboarding:pipeline"`:

```tsx
        "onboarding:pipeline": <OnboardingPipelineScreen initial={onboarding} />,
        "onboarding:stages": <OnboardingStagesScreen initial={onboardingStages} />,
        "onboarding:templates": <OnboardingTemplatesScreen initial={onboardingTemplates} />,
        "onboarding:settings": <OnboardingSettingsScreen initial={onboardingSettings} />,
```

Every screen takes `initial` and tolerates `null` — if the loader was skipped,
the screen fetches its own API route on mount, sharing one request through
`loadOnce`. So a wrong guess about which loader to run costs a round trip, never
a blank screen.

---

## Addresses this produces

| Destination id | Address | API route behind it |
|---|---|---|
| `onboarding:pipeline` | `/onboarding` | `GET /api/tools/onboarding` |
| `onboarding:stages` | `/onboarding/stages` | `GET,POST /api/tools/onboarding/stages` |
| `onboarding:templates` | `/onboarding/templates` | `GET,POST /api/tools/onboarding/templates` |
| `onboarding:settings` | `/onboarding/settings` | `GET,PATCH /api/tools/onboarding/settings` |

---

## After wiring, re-run the tests with no arguments

Both scripts default to `/onboarding/...`, so once the change above is in:

```
node scripts/onboarding-ui-test.mjs        # 34 checks
node scripts/onboarding-layout-test.mjs    # 3 screens
```

They were run for this task against a temporary harness at
`/onboarding-preview/[screen]`, because an unwired screen has no address and a
screen with no address cannot be driven by a browser. That harness has been
deleted. If you want it back to test before wiring, it was one file —
`src/app/onboarding-preview/[screen]/page.tsx` — rendering each screen inside
`<section className="screen on">` with its loader's output as `initial`, and
both scripts still accept `ONBOARDING_PATH_PREFIX=/onboarding-preview`.

---

## Not wired, and deliberately

`src/lib/tools/onboarding/steps.ts` (the 14 step buttons) and
`setClientAccountManager` are ported and exercised, but nothing in the workspace
renders them yet: they belong to the client detail page, which this port does
not carry. See ONBOARDING-PARITY.md — that page is the open question.
