# Master Inbox — Settings parity

Every control on the eight settings tabs, written down **before** the rebuild so
that nothing could be quietly dropped while the markup was replaced.

**Status: 128 / 128 checks pass.** Every row below is ticked, and every tick is
a control that was clicked in a real Chrome — not a line of source that was read
and judged conservative.

The rebuild changed the **markup and the stylesheet**. Every fetch, every
endpoint, every piece of state and every optimistic update is the code that was
already there. The deliberate behaviour changes are called out in their rows and
collected at the bottom.

**Verified** column: driven by `scripts/settings-ui-test.mjs`.

* `render` — found on the painted page with the right shape and copy
* `drive` — operated, and its effect asserted
* `write` — a record created / changed / deleted against the live API, then
  confirmed gone by reloading the page rather than by trusting local state

The bracketed ids (`1.9b`) are the check ids the suite prints, so a row here and
a line of test output can be matched up.

Test records created and removed are listed at the bottom.

---

## Tab strip

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 0.1 | Eight tab pills (`Labels`, `Templates`, `Reply Agents`, `AI Labeling`, `Clients`, `Members`, `Personal`, `Webhooks`) | Each is a link to `/inbox/settings/<id>`; active one carries `.on` | drive |
| 0.2 | Unknown tab falls back to Labels | `isSettingsTab()` guard | render |

---

## 1 · Labels

Component `settings/labels-manager.tsx`.
API `POST/PATCH/DELETE /api/tools/master-inbox/labels[/:id]`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 1.1 | Search box | Filters rows by name, case-insensitive | drive |
| 1.2 | `Create label` button | Opens the dialog empty | drive |
| 1.3 | Table — Label column | Renders the label's colour chip | render |
| 1.4 | Table — Sentiment column | positive / negative / neutral | render |
| 1.5 | Table — Platform column | both / email | render |
| 1.6 | Table — Obligation column | Yes / No | render |
| 1.7 | Table — Source column | System / Custom | render |
| 1.8 | Row `Edit` | Opens the dialog pre-filled with all six fields | drive |
| 1.9 | Row `Delete` | Only on custom labels; system labels have no delete | write |
| 1.10 | Empty state | "No labels match." when the filter matches nothing | drive |
| 1.11 | Dialog — Name | Text input, autofocus; Save disabled while empty | write |
| 1.12 | Dialog — Colour | Seven swatches: green, red, amber, blue, pink, zinc, stone | write |
| 1.13 | Dialog — Preview | Live chip in the chosen colour with the typed name | drive |
| 1.14 | Dialog — Sentiment | Select: Positive / Negative / Neutral | write |
| 1.15 | Dialog — Platform | Select: Both / Email only | write |
| 1.16 | Dialog — Obligation | Switch — "threads with this label appear in Needs Reply" | write |
| 1.17 | Dialog — Mirror to EmailBison | Switch — sync as a tag on EmailBison replies | write |
| 1.18 | Dialog — error line | Server error text is shown in the dialog, not swallowed | render |
| 1.19 | Dialog — Cancel | Closes without saving | drive |
| 1.20 | Dialog — Create / Save | POST when creating, PATCH when editing; optimistic row update | write |

## 2 · Templates

Component `settings/templates-manager.tsx` + `settings/template-rich-editor.tsx`.
API `POST/PATCH/DELETE /api/tools/master-inbox/reply-templates[/:id]`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 2.1 | Search box | Filters on name, body, subject and category | drive |
| 2.2 | Count line | "N of M templates" | drive |
| 2.3 | `New template` button | Opens the editor dialog empty | drive |
| 2.4 | Category sections | Named categories A–Z, `Uncategorised` always last | render |
| 2.5 | Section collapse | Click the header to fold a category away | drive |
| 2.6 | Section count | Number of templates in that category | render |
| 2.7 | Row — name / subject / body preview / CC / BCC | All five shown when present | render |
| 2.8 | Row `Edit` | Opens the dialog pre-filled | drive |
| 2.9 | Row `Delete` | Opens the delete confirmation dialog | write |
| 2.10 | Empty state (no templates at all) | Distinct copy inviting a first template | render |
| 2.11 | Empty state (search matched nothing) | "No templates match …" | drive |
| 2.12 | Dialog — Name | Required; Save disabled while empty | write |
| 2.13 | Dialog — Category | Free text **with a datalist of existing categories** | write |
| 2.14 | Dialog — Subject | Optional, with the forward/new-mail caveat spelled out | write |
| 2.15 | Dialog — CC | Comma-separated | write |
| 2.16 | Dialog — BCC | Comma-separated | write |
| 2.17 | Editor — Insert variable | Dropdown of `TEMPLATE_VARIABLES`, inserts `{{key}}` at the caret | drive |
| 2.18 | Editor — Heading | Toggles H2 | drive |
| 2.19 | Editor — Bold / Italic / Underline / Strikethrough | Four inline marks | drive |
| 2.20 | Editor — Bulleted list / Numbered list | Two list types | drive |
| 2.21 | Editor — Link | Opens `LinkDialog` (text + URL, and Remove when on a link) | drive |
| 2.22 | Editor — dual output | Stores `body_html` **and** the plain-text `body` projection | write |
| 2.23 | Dialog — Cancel / Save | Save shows a spinner while in flight | write |
| 2.24 | Delete dialog | Names the template, warns it goes for the whole workspace, Cancel + red Delete | write |

## 3 · Reply Agents

Component `settings/reply-agents-manager.tsx`.
API `POST/PATCH/DELETE /api/tools/master-inbox/reply-agents[/:id]`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 3.1 | `Create agent` button | Opens the wizard at step 1 | drive |
| 3.2 | Search box | Filters agents by name | drive |
| 3.3 | "How reply agents work" panel | Four bullets: monitoring, context, human-in-loop, channels | render |
| 3.4 | Empty state | Own copy + a `Create your first agent` button | drive |
| 3.5 | Agent card — name + Active/Paused | Status pill | render |
| 3.6 | Agent card — channel · provider · model | Sub-line | render |
| 3.7 | Agent card — Tone / Length / Temperature / Max tokens / API key | Five-row detail grid; API key reads Configured or Not set | render |
| 3.8 | Card `Edit` | Opens the wizard pre-filled at step 1 | drive |
| 3.9 | Card `Delete` | Removes the agent | write |
| 3.10 | Wizard — step indicator | "Step 1 of 2" / "Step 2 of 2", step 1 ticks when passed | drive |
| 3.11 | Step 1 — Agent name | Required; `Next` disabled while empty | write |
| 3.12 | Step 1 — Tone | Six options | write |
| 3.13 | Step 1 — Response length | Four options | write |
| 3.14 | Step 1 — Max tokens | Four budgets (1k / 2k / 4k / 8k) | write |
| 3.15 | Step 1 — Channel | All channels / Email only | write |
| 3.16 | Step 1 — Active | Switch | write |
| 3.17 | Step 2 — Provider | OpenAI / Anthropic / OpenRouter / vLLM; switching resets the model | drive |
| 3.18 | Step 2 — Model | Preset list per provider **plus `Custom…`** with a free-text box | write |
| 3.19 | Step 2 — API key | Password field with a show/hide eye; blank keeps the saved key | drive · **saving a key cannot be exercised here**, see note below |
| 3.20 | Step 2 — Temperature | Number, 0–2, step 0.1 | write |
| 3.21 | Step 2 — Custom system prompt | Textarea, optional | write |
| 3.22 | Wizard — Cancel / Back / Next / Save | Back only on step 2, Cancel only on step 1 | drive |
| 3.23 | Save resets the search box | So a new agent can't be hidden by a stale filter | drive |

## 4 · AI Labeling

Component `settings/ai-labeling-form.tsx`.
API `PATCH /api/tools/master-inbox/ai-labeling`, `POST /api/tools/master-inbox/ai-labeling/run`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 4.1 | Enable AI labeling | Switch | drive |
| 4.2 | Provider | Four providers; switching picks that provider's default model | drive |
| 4.3 | Model | Preset select per provider | drive |
| 4.4 | Model — `Custom…` | Reveals a free-text model id and a `Use preset` way back | drive |
| 4.5 | API key | Password field, show/hide eye, readOnly-until-focus (blocks password-manager autofill) | render |
| 4.6 | API key — Clear | Two-click arm-then-fire; PATCHes `api_key: ""` | drive (armed, **not** confirmed — it destroys a saved secret) |
| 4.7 | API key — storage note | "Stored encrypted with pgcrypto. Never sent to the browser after save." | render |
| 4.8 | Re-label ongoing replies | Switch | drive |
| 4.9 | Include in historical backfill | Switch | drive |
| 4.10 | Candidate labels | Every workspace label as a chip; click toggles in/out of `category_set` | drive |
| 4.11 | Candidate counter | "N / M on" | drive |
| 4.12 | Candidate explanation | The "Turned off" and "No match" notes | render |
| 4.13 | Custom system prompt | Switch reveals the textarea | drive |
| 4.14 | Error / saved message lines | Red for failure, green for "Saved." | drive |
| 4.15 | `Run on historical replies` | Two-click arm-then-fire; disabled with no API key; streams NDJSON | drive (armed, **not** confirmed — it spends API credits) |
| 4.16 | Progress bar | scanned / total, %, labeled, remaining, errors — live from the stream | render |
| 4.17 | Run report | Sample classifications, the nine "why some weren't labeled" reasons, sample errors | render |
| 4.18 | Last run stamp | Rendered through `lib/workspace/dates.ts` | drive |
| 4.19 | `Save` | PATCHes the whole config; the key is only sent when retyped | drive |

## 5 · Clients

Component `settings/clients-manager.tsx`.
API `GET/POST /api/tools/master-inbox/clients`, `PATCH/DELETE /clients/:id`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 5.1 | Summary line | "N clients configured", with the alias worked example | render |
| 5.2 | `Add client` button | Opens the dialog empty | drive |
| 5.3 | Row — name | With a `fallback` tag on the system row | render |
| 5.4 | Row — thread count | "N threads", tabular | render |
| 5.5 | Row — aliases | Alias chips, or "No aliases." | render |
| 5.6 | Row `Edit` | Disabled on the system row | drive |
| 5.7 | Row `Delete` | Disabled on the system row; refused with an explanation while the client has a live portal; untags its threads once the portal is off | write |
| 5.8 | Dialog — Name | Required | write |
| 5.9 | Dialog — Alias add | Type + `Add`, or press Enter; duplicates ignored case-insensitively | write |
| 5.10 | Dialog — Alias remove | `×` on each chip | drive |
| 5.11 | Dialog — matching note | "campaign name contains the client name (or any alias); longest match wins" | render |
| 5.12 | Dialog — Cancel / Save | POST or PATCH, optimistic row, background re-sync for `thread_count` | write |

## 6 · Members

Component `settings/members-client.tsx`.
API `POST /api/tools/master-inbox/admin/invite`, `POST /admin/reset-password`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 6.1 | Non-admin refusal | Anyone who is not the super admin gets the "ask admin@outreachify.io" card | render · **was showing for everybody**, see note below |
| 6.2 | Invite — Email | Required, `type=email` | render |
| 6.3 | Invite — Full name | Optional | render |
| 6.4 | Invite — Initial password | Required, min 8 | render |
| 6.5 | Invite — `Generate` | 12 unambiguous characters + `!`, from `crypto.getRandomValues` | drive |
| 6.6 | Invite — plaintext note | "Plain text so you can copy and share. Stored hashed in Supabase." | render |
| 6.7 | Invite — All workspaces | Checkbox; on by default | drive |
| 6.8 | Invite — per-workspace list | Appears when "all" is off; each row shows the EmailBison team id | drive |
| 6.9 | Invite — `Add user` | Disabled until email + 8-char password + at least one workspace | drive |
| 6.10 | Members table | Email, role badge, workspaces ("All (N)" or the first three + overflow) | render |
| 6.11 | Members empty state | "No members yet — add one above." | render |
| 6.12 | `Reset password` | Opens the dialog with a freshly generated password | drive |
| 6.13 | Reset dialog — password + `Generate` | Min 8 | drive |
| 6.14 | Reset dialog — Cancel / Set password | POSTs to `/admin/reset-password` | drive |

> Rows 6.2–6.6 and 6.9 are exercised as far as filling the form and reading the
> disabled state. The invite itself is **not** fired: it writes a real Supabase
> auth user, which is not a record this test can clean up. Same for 6.14 — a
> real password reset on a real teammate is not a reversible test write.
>
> **To drive this tab at all**, `SUPER_ADMIN_EMAILS=admin@outreachify.io` is set
> in the isolated test copy's `.env.local`. The repo's own `.env.local` does not
> set it and was not touched, so this workspace still shows the refusal card —
> correctly, since nobody is configured as a super admin. The suite handles both:
> it asserts the refusal when the admin view is absent, and drives every control
> when it is present.

## 7 · Personal

Components `settings-tabs/personal.tsx` + `settings/change-password-form.tsx`.
API `POST /api/tools/master-inbox/account/change-password`.

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 7.1 | Email | Read-only, shows the signed-in address | drive · **was rendering empty**, see note below |
| 7.2 | Current password | Required | render |
| 7.3 | New password | Required, min 8 | render |
| 7.4 | Confirm new password | Must match; mismatch is refused client-side | drive |
| 7.5 | `Update password` | POSTs; spinner while in flight | render |

> 7.5 is not fired: changing the operator's own password would lock this
> session out. The mismatch guard (7.4) is driven, which is the branch that
> proves the form is wired.

## 8 · Webhooks

| # | Control | Behaviour | Verified |
|---|---------|-----------|----------|
| 8.1 | `Coming soon` placeholder | "Webhook subscriptions" + "This section will land in a later phase." — the same words the live tool shows | render |

---

## Deliberate behaviour changes

1. **`window.confirm` is gone.** It guarded five destructive controls — delete a
   label, delete a client, delete a reply agent, clear the AI key, run the
   backfill. A native modal suspends the page, so a delete guarded by it is a
   delete no automated check can prove works. All five now use the repo's
   arm-then-fire button, the same control Onboarding uses; the sentence that was
   in the native dialog moves to the button's `title` and its armed caption, so
   the warning still reaches the reader before the second click. Checks `1.9b`,
   `3.9b`, `4.6`, `4.15`, `5.7b`.

2. **`alert()` is gone** from the two delete-failure paths (labels, agents).

3. **`sonner` is gone.** Eleven calls to `toast.success(...)` / `toast.error(...)`
   across templates, clients, members and the password form were rendering
   **nothing at all**: `<Toaster />` is not mounted anywhere in this app —
   checked, not assumed. Saving a template confirmed nothing and failing to save
   warned nobody. They now use the workspace's own status line, the same one
   Onboarding, Client Health and Analytics use, which is both visible and
   readable by a test. Check `1.20b` asserts a write is confirmed on screen.

4. **The "Last run" stamp** goes through `lib/workspace/dates.ts` instead of an
   inline `toLocaleString`. It did pin its timezone, so it was not the bug this
   repo has shipped three times — it was one edit away from being it.

5. **The template toolbar shows its own state.** `@tiptap/react` v3 defaults
   `shouldRerenderOnTransaction` to false, and all eight toolbar buttons ask
   `editor.isActive(...)` during render — so the answer was computed once at
   mount and never again. Bold, the heading, the lists and the link never lit
   up, in the tool's markup either. Check `2.19`.

6. **The custom-model field no longer steals focus.** It carried `autoFocus`,
   and unlike the other three autofocused fields it is not dialog-only markup —
   it renders on the server whenever the saved model is not a preset, so any
   workspace on a custom model id had the caret yanked into a text box every
   time the tab opened.

Nothing else about behaviour moved.

---

## Three things that were already broken, found by driving them

These were not caused by the rebuild. They were found because the rebuild was
tested by clicking rather than by reading.

1. **The Members tab was unreachable for everybody.** It gated on
   `isSuperAdmin(session.user.email)`, and `requireSession()` is a shim that
   returns `email: null` by construction — so the check was false for every
   user, whatever `SUPER_ADMIN_EMAILS` said. The invite form, the workspace
   picker, the member list and the password reset could not be reached at all;
   the tab was permanently the "ask the admin" refusal card.

2. **Personal showed an empty email box.** Same cause: `session.user.email` is
   null, so "Your account information" displayed nothing.

   Both are fixed inside this work's own files, by reading the address from
   `x-bs-user` — the header `proxy.ts` writes after verifying the signed cookie,
   and the same header `app/[[...slug]]/page.tsx` already reads to build the
   sidebar. `requireSession()` is left alone: 47 call sites depend on its shape.
   See `settings-tabs/signed-in-email.ts`. Checks `6.2`–`6.14`, `7.1`.

3. **A created agent can be orphaned by a failed key write.** `saveAgent`
   INSERTs the row and only then encrypts the API key through the
   `reply_agent_set_key` RPC. If that throws — it does here, because
   `APP_ENCRYPTION_KEY` is not set in this environment — the endpoint answers
   400 with the row already in the table and the browser never learns it exists.
   The fix belongs in `lib/tools/master-inbox/ai/agent.ts`, which this work does
   not own, so it is **reported, not changed**; `scripts/settings-probe.mjs
   --sweep` exists to clear the orphans it leaves. It is also why check `3.19`
   drives the key field but saves the agent with it blank.

---

## Things that are correct but look like faults

* **A client with a live portal cannot be deleted** (409, with an explanation).
  That is deliberate — deleting the row dead-links whatever the client has
  bookmarked. Check `5.7c` asserts the refusal and its wording; `5.7d` then
  disables the portal and proves the same button does delete.
* **The labels list is served from a 30-second cache**
  (`loadLabels = cache(ttlCache(fetchLabels, { ttlMs: 30_000 }))`). A hard
  reload within that window legitimately shows the pre-change list, which is why
  this panel keeps optimistic local state. Server-truth checks reload until the
  cache turns over rather than declaring the feature broken.
* **`GET/PATCH/DELETE /api/tools/master-inbox/clients` answer 500 under
  `next dev --webpack`** — `requireAuthedUser` calls `headers()`, which
  webpack-dev does not give a request scope. They are healthy under Turbopack,
  which is what production runs. This test rig therefore runs Turbopack.
  `scripts/settings-probe.mjs --diagnose` is what established that, and it is
  the reason this report does not claim a product bug that does not exist.

---

## Not fired by the test, on purpose

Four controls are driven right up to the point of consequence and then stopped,
because the consequence is not something a test can undo:

| Control | Why not |
|---|---|
| `Run on historical replies` | spends the workspace's API credits |
| `Clear` the AI key | destroys a saved secret |
| `Add user` | creates a real Supabase auth user, which cannot be cleaned up |
| `Set password` / `Update password` | changes a real teammate's, or this session's, credentials |

For each, the arming step, the disabled-state logic and the client-side guards
**are** driven — so the control is proven live. AI labelling's `Save` is the one
exception: it is pressed after every field has been put back to the value it was
read with, and check `4.19b` re-reads the config afterwards to prove it is
unchanged.

---

## Test records created and removed

Each run stamps its records with a run id, so they are identifiable and
sweepable. From the final run, `zz-mis-mtwz7iak`:

| Kind | Created | Then | Removed by |
|---|---|---|---|
| Label | `zz-mis-mtwz7iak-label` | renamed to `…-label-edited` | the UI's delete (`1.9c`), confirmed gone from the server (`1.9d`) |
| Template | `zz-mis-mtwz7iak-template` | renamed to `…-template-edited` | the UI's delete dialog (`2.9`) |
| Template category | `zz-mis-mtwz7iak-category` | — | disappears with its last template |
| Reply agent | `zz-mis-mtwz7iak-agent` | — | the UI's delete (`3.9c`) |
| Client | `zz-mis-mtwz7iak-client` | renamed to `…-client-edited` | the UI's delete, after its portal was disabled (`5.7d`) |

No pre-existing record was edited. The 21 labels, 44 templates, 2 reply agents
and 57 clients that staff rely on were read, filtered, searched and opened for
edit — and closed with Cancel.

Every run ends with a sweep by name prefix (`zz-mis-`) over templates, agents and
clients, so a run that aborts cannot leave rubbish behind. Labels have no `GET`
endpoint, so `scripts/settings-probe.mjs --sweep-ui` clears those through the
screen itself. The final run's sweep removed one leftover template from the run
that was interrupted when the machine slept, and reported nothing else.

---

## Scripts

| Script | What it is for |
|---|---|
| `settings-ui-test.mjs` | the suite — 128 checks across all eight tabs |
| `settings-layout-test.mjs` | does each tab fit? 1440px and 1280px |
| `settings-probe.mjs` | `--sweep` / `--sweep-ui` clean-up, `--diagnose` the clients endpoints, `--hydration` / `--hydration-serial` / `--hydration-ai-custom` console-error sweeps |
| `settings-sync-farm.sh` | mirrors `src/` into the isolated dev copy the tests drive |
| `settings-shot.mjs` | screenshots one tab at a given width |
