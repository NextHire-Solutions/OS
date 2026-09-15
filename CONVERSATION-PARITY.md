# Master Inbox — conversation view parity

Every control and behaviour that `thread-view.tsx`, `prospect-panel.tsx` and
`thread-detail.tsx` carried **before** the visual rebuild, written down first so
the rebuild has an acceptance test rather than an opinion.

The rebuild changed **markup and CSS classes only**. No handler, no fetch, no
state machine, no prop and no derivation was touched — every function in both
files is byte-identical apart from the JSX it returns.

Status column:

- **✅** — verified working in a real Chrome (`scripts/conversation-ui-test.mjs`),
  after the rebuild.
- **✅ (code)** — the handler is unchanged and reachable, but firing it in the
  test would mutate production data (send an email, move an agent between
  clients, enrol a lead in a sequence). The control is asserted present,
  enabled and wired; the network call is not fired.

---

## 1. Conversation toolbar — `thread-view.tsx`

| # | Control | Behaviour | Status |
|---|---------|-----------|--------|
| 1.1 | Back | `<a href={backHref}>`; `backHref` carries `?f/?list/?page/?q` | ✅ |
| 1.2 | Previous thread | `<a href={prevThreadHref}>`, disabled (`opacity-40 pointer-events-none` → `.is-off`) when there is no previous row | ✅ |
| 1.3 | Next thread | as above with `nextThreadHref` | ✅ |
| 1.4 | Refresh | `router.refresh()` inside `startTransition`; disabled while pending | ✅ |
| 1.5 | Move agent | `<MoveAgentMenu compact>` — lazy-loads `/api/tools/master-inbox/clients`, moves via `threads/bulk` `action:"move_client"`, disables the current client | ✅ (code) |
| 1.6 | Labels | `<LabelPickerButton>` — dropdown, filter box, single-label-per-thread toggle, optimistic state + rollback | ✅ |
| 1.7 | Snooze | `<SnoozeButton>` — 5 presets + a custom datetime, POSTs `threads/{id}/snooze`, un-snooze when `status==="reminder"` | ✅ |
| 1.8 | Mark unread | `bulkAction({action:"seen", seen:false})` then `router.push(backHref)` | ✅ (code) |
| 1.9 | Archive / Move to inbox | icon and label flip on `status==="archived"`; `action:"status"` → `archived` / `open` | ✅ (code) |
| 1.10 | Delete / Restore from trash | icon and label flip on `status==="trash"`; **two-click arm-then-fire** replaces the old `window.confirm` | ✅ |
| 1.11 | Pending state | every button takes `disabled={pending}` from the same `useTransition` | ✅ |

## 2. Messages — `thread-view.tsx` / `MessageBlock`

| # | Control | Behaviour | Status |
|---|---------|-----------|--------|
| 2.1 | Oldest-first order | `detail.messages` rendered as given | ✅ |
| 2.2 | Empty thread | "No messages in this thread yet." | ✅ |
| 2.3 | Direction alignment | outbound right / inbound left, capped at 88% width | ✅ |
| 2.4 | Sender resolution | `resolveInboundSenderName` — stored name → lead name on address match → `"Name <addr>"` scraped from the body → titlecased local part | ✅ |
| 2.5 | Avatar | initials, inbound green / outbound blue | ✅ |
| 2.6 | Subject + timestamp | per-message subject, ET-pinned stamp | ✅ |
| 2.7 | Reply (per message) | inbound only → `{mode:"reply", source:m, replyAll:false}` | ✅ |
| 2.8 | Reply all (per message) | inbound only → `replyAll:true` | ✅ |
| 2.9 | Forward (per message) | inbound only → `{mode:"forward", source:m}` | ✅ |
| 2.10 | From / To / Cc header block | `MessageHeaders`, hidden when there is nothing to show | ✅ |
| 2.11 | Body: HTML | `sanitizeEmailHtml`, `[&_a]` brand-blue underlined, images capped | ✅ |
| 2.12 | Body: plain text | `<pre>` with `whitespace-pre-wrap` in the sans face | ✅ |
| 2.13 | Collapse to 140px + fade | `COLLAPSED_HEIGHT_PX`, gradient mask while collapsed | ✅ |
| 2.14 | Expand / collapse chevron | per-message `expanded` state, `aria-label` flips | ✅ |

## 3. Composer entry points — `thread-view.tsx`

| # | Control | Behaviour | Status |
|---|---------|-----------|--------|
| 3.1 | Floating Reply button | `{mode:"reply", source:null}`; hidden while the composer is open so it cannot sit on the Send button | ✅ |
| 3.2 | Reply subject | source message's subject (not the thread's first), normalised to exactly one `Re: ` | ✅ |
| 3.3 | Forward subject | `Fwd: ` + source subject, **editable** (`subjectLocked` false) | ✅ |
| 3.4 | Reply subject | `subjectLocked` true in reply mode. **The composer ignores the prop on purpose** — it keeps the field editable and warns in the `title` ("Changing the subject on a reply may break threading on the recipient's side"). Pre-existing tool behaviour, unchanged here; the test asserts the warning. | ✅ |
| 3.5 | Reply recipients | `buildReplyRecipients` — TO = source sender / first non-us recipient / lead; CC + BCC = the source's own, minus us and TO | ✅ |
| 3.6 | Reply-all recipients | CC + BCC = the union across every message in the thread, first-seen order, de-duplicated | ✅ |
| 3.7 | Forward body | `buildForwardBody` — text body, else HTML flattened with breaks kept, else `(original message had no body)` | ✅ |
| 3.8 | `forwardedBlock` | the same quote handed over separately so an emptied textarea still sends the original | ✅ |
| 3.9 | Quoted block on reply | sender / sent_at / text / html of the source | ✅ |
| 3.10 | `sourceMessageId` | that message on a per-message reply, `null` from the floating button (API falls back to latest inbound) | ✅ |
| 3.11 | AI draft + saved draft | `detail.pending_draft` and `detail.composer_draft` passed in reply mode only | ✅ |
| 3.12 | From address | `outbound_sender_email` → last outbound `sender` → null; display name from the channel | ✅ |
| 3.13 | Lead company / title / phone | read from the lead row, then from `custom_fields` under several key spellings | ✅ |
| 3.14 | Channels | full connected-mailbox list forwarded to the sender picker | ✅ |
| 3.15 | Signature | `outbound_sender_signature` | ✅ |
| 3.16 | Close | `onClose` → `setComposeState(null)` | ✅ |

## 4. Composer interior (`composer.tsx` — unchanged, must keep working)

| # | Control | Status |
|---|---------|--------|
| 4.1 | From / sender picker (searchable, provider-scoped) | ✅ |
| 4.2 | To, Cc, Bcc fields + Cc/Bcc toggles | ✅ |
| 4.3 | Subject field + clear button (forward only) | ✅ |
| 4.4 | Rich-text body editor | ✅ |
| 4.5 | Attach file / attach image, 50MB cap, removable chips | ✅ |
| 4.6 | Templates picker (lazy-loaded, grouped, searchable) | ✅ |
| 4.7 | AI reply generation | ✅ (code) |
| 4.8 | Send | ✅ (code) |
| 4.9 | **Overlays, does not split the pane** (`inbox-theme.css`) | ✅ |
| 4.10 | Prospect panel stays above the composer | ✅ |

## 5. Prospect panel — `prospect-panel.tsx`

| # | Control | Behaviour | Status |
|---|---------|-----------|--------|
| 5.1 | Resizable width | pointer drag on the left edge, 300–580px | ✅ |
| 5.2 | Width persisted | `localStorage["inbox-prospect-panel-width"]`, range-checked, try/catch | ✅ |
| 5.3 | Identity block | initials avatar, full name, email | ✅ |
| 5.4 | Copy email | `navigator.clipboard` + toast | ✅ |
| 5.5 | Thread labels | every assigned label as a chip | ✅ |
| 5.6 | Tabs: Details / Attachments / Notes | `tab` state; the two empty states are the tool's own copy | ✅ |
| 5.7 | Agent card | collapsible, open by default | ✅ |
| 5.8 | Lead details card | collapsible, only when there is something to show | ✅ |
| 5.9 | Name / Company / Location / Website / Campaign / Client / Source rows | value derivation via `find()` over normalised `custom_fields` keys | ✅ |
| 5.10 | Location merge | `city` + `state` joined unless already contained | ✅ |
| 5.11 | Website / URL linkified | `LinkValue`, `target="_blank" rel="noopener noreferrer"` | ✅ |
| 5.12 | Copy on every field | hover-revealed copy button | ✅ |
| 5.13 | Agent emails list | lead email + `custom_fields.emails`, de-duplicated case-insensitively | ✅ |
| 5.14 | Preferred email | checkbox shown at 2+ addresses; `PATCH .../agent-email`; toast names how many portals were updated | ✅ (code) |
| 5.15 | + Add email | inline input, Enter saves, Escape cancels, `POST .../agent-email` | ✅ |
| 5.16 | Agent phones list | `custom_fields.phones`, else the single derived phone | ✅ |
| 5.17 | Preferred phone | as 5.14 against `.../agent-phone`, compared by digits | ✅ (code) |
| 5.18 | + Add phone | as 5.15 against `.../agent-phone` | ✅ |
| 5.19 | Subsequences | `<SubsequenceSection>` — Instantly threads with a campaign only | ✅ |
| 5.20 | Follow-up campaigns | `<FollowupCampaignPicker>` — EmailBison threads only | ✅ |
| 5.21 | Lead-detail rows | Title, LinkedIn, then every unconsumed `custom_fields` entry, keys prettified | ✅ |

## 6. Screen shell — `thread-detail.tsx`

| # | Control | Behaviour | Status |
|---|---------|-----------|--------|
| 6.1 | Twelve parallel loaders + `seen:true` in one `Promise.all` | unchanged | ✅ |
| 6.2 | Per-loader timing logs | unchanged | ✅ |
| 6.3 | `buildSuffix` on Back / Prev / Next | unchanged | ✅ |
| 6.4 | `notFound()` on a missing thread | unchanged | ✅ |
| 6.5 | Saved-view filter fallback | unchanged | ✅ |
| 6.6 | Search bar (TopBar) | unchanged | ✅ |
| 6.7 | View tabs | **now `MockupTabs`**, matching the list screen — see "Deliberate changes" | ✅ |
| 6.8 | Filter builder (FilterBar) | unchanged, now inside the design's `.mi-filter` band | ✅ |
| 6.9 | Thread list rail | the tool's `<ThreadList compact>` — scroll memory, optimistic seen, pagination, click timing — restyled from CSS, not rewritten | ✅ |
| 6.10 | Realtime refresher | unchanged | ✅ |
| 6.11 | Click→render timing probe | unchanged | ✅ |
| 6.12 | Channel → email map for the sender picker | unchanged | ✅ |

---

## Results

**40 / 40 checks pass** in a real Chrome against the real database
(`node scripts/conversation-ui-test.mjs`, PORT=3360, CDP 9450), and
**12 / 12 layout measurements** fit the viewport at 1440 / 1280 / 1100px
(`scripts/conversation-layout-test.mjs`), as do 5 / 5 of the repo's own
`scripts/layout-test.mjs` screens at the same three widths.
`npx tsc --noEmit -p tsconfig.json` → **0 errors under `src/`**.

Every row above is ticked. Nothing was dropped.

---

## Deliberate changes

Five things are different on purpose. Each is a match to the approved mockup
(`brokerstaffer-workspace.html`, section `#mi-thread`) rather than a loss.

1. **The view tabs are now the design's pill tabs.** This screen ran the tool's
   `TabBar` while `/inbox/<view>` ran `MockupTabs`, so one click swapped a row
   of pill tabs for a row of underlined ones. Same `loadViews` /
   `loadViewCounts` data, same destinations. What the tool's `TabBar` carried
   and `MockupTabs` does not — drag-to-reorder, the create-view dialog,
   per-view menus — was **already** absent from the list screen, so nothing is
   reachable today that was not reachable before this change.

2. **Move agent is the tool's `compact` variant.** The prop exists in
   `move-agent-menu.tsx` and its own comment names this toolbar as where it
   belongs; it had simply never been switched on. The label survives as the
   button's `title` and `aria-label`.

3. **Delete arms instead of calling `window.confirm`.** The first click turns
   the button red and the strip reads "Delete — click again"; a second click
   inside four seconds fires; it disarms itself after that. `confirm()`
   suspends the page, which made the one destructive action on this screen the
   one action no test could reach.

4. **The rail's "All messages" heading is gone.** The mockup's rail has exactly
   one header row and it is the count — "1–50 of 1,284" — which the tool's own
   strip already renders together with the pagination arrows a static label
   would have pushed onto a second row.

5. **The prospect panel's field rows have no icons.** The mockup draws `.prow`
   as a plain uppercase key and a value; the glyphs were the tool's. The label
   text is unchanged and more explicit than the glyph was.

Two smaller ones, both inside the rebuilt files:

- `formatTime()` is replaced by `fullStamp()` from `src/lib/workspace/dates.ts`
  — the repo's pinned, memoised Eastern formatter. The weekday abbreviation
  ("Wed, ") is no longer printed; the date and time are identical.
- The message body's link colour moves from the tool's `#1565C0` to the
  design's one blue, `#0165FE` (`--blue`).

---

## Pre-existing defects found while testing

Neither is in a file this rebuild owns; both are reported rather than fixed.

**`composer.tsx` loses the draft when you navigate away.** Its unmount flush
uses `navigator.sendBeacon`, which is always a `POST`, against
`/api/tools/master-inbox/threads/[threadId]/composer-draft`, which exports only
`PUT` and `DELETE`. Every navigation away from an open composer produces a
`405` and the last 1.5s of typing is lost. The debounced `PUT` while typing
works, so the symptom is narrow and easy to miss. Fix is one word in either
file — the route needs a `POST` alias, or the beacon needs replacing with a
`keepalive` `PUT`.

**An intermittent hydration warning from base-ui's `<Checkbox>` in the thread
rail.** React reports "a tree hydrated but some attributes … didn't match" with
`id="base-ui-_R_92piqd…"` against a server `id="base-ui-_R_14b6b9p…"` — a
`useId` mismatch on the checkbox in `thread-list.tsx`, a file this rebuild does
not touch.

It is **not** an unpinned `toLocaleString` and **not** dnd-kit, the two causes
this repo has seen before. It was bisected against `git show HEAD:` copies of
all three rebuilt files in an isolated run tree: the pre-rebuild code
reproduces the identical warning on the same sequence (`/inbox/all-email`,
then the same thread six times — it fires on a random one of those loads, and
only after the list screen has been visited first). Nothing in this rebuild
changed the rail's markup; it runs the tool's `<ThreadList compact>` unchanged
and restyles it from CSS.

Practical impact is nil — the id is referenced by nothing
(`aria-labelledby={undefined}`) — but it is real and it belongs to whoever owns
`thread-list.tsx` / `mi-ui/checkbox.tsx`.

---

## Test output

```
  Master Inbox · conversation view — http://localhost:3360

  thread under test: /inbox/all-email/3a40048d-d66e-4d46-95e1-b2c3427c5b23
  --- 1 · shell + design language ---
  ✓ 1.0   three-pane frame (.mi-conv rail/main/prospect)
  ✓ 1.0b  every pane is inside .mi-theme
  ✓ 1.1   design classes present, tool classes gone
  ✓ 1.2   tokens resolve (no unpainted CSS variables)
  --- 2 · toolbar ---
  ✓ 2.1   Back link keeps the view (and any ?f/?list/?page/?q)
  ✓ 2.2   Previous / Next present, disabled state honest
  ✓ 2.3   Refresh re-renders the thread
  ✓ 2.4   Move agent opens and lists clients — 57 clients (not fired)
  ✓ 2.5   Snooze opens with its presets — 6 options incl. Custom date & time…
  ✓ 2.6   Labels: remove and re-apply — "Not Interested" → [] → ["Not Interested"]
  ✓ 2.7   Archive, then Move to inbox — icon and label flip
  ✓ 2.8   Mark unread fires and returns to the list
  ✓ 2.9   Delete ARMS instead of calling window.confirm — confirm()=false (never fired)
  --- 3 · messages ---
  ✓ 3.1   messages render, oldest first, aligned by direction
  ✓ 3.2   avatars: inbound green, outbound blue
  ✓ 3.3   From / To / Cc header block
  ✓ 3.4   collapse → expand → collapse — 140px → none (h=509) → 140px
  ✓ 3.5   Reply / Reply all / Forward on inbound only
  --- 4 · composer ---
  ✓ 4.1   floating Reply opens the composer and hides itself
  ✓ 4.2   composer OVERLAYS — conversation still 394px; panel z=40 above composer z=30
  ✓ 4.3   reply is pre-filled: To, Re: subject, threading warning
  ✓ 4.4   composer controls: attach ×2, templates, AI reply, sender, send, editor
  ✓ 4.5   Templates picker lists the workspace's templates
  ✓ 4.6   Sender picker lists connected mailboxes
  ✓ 4.7   composer closes
  ✓ 4.8   per-message Reply all carries the thread's Cc
  ✓ 4.9   Forward seeds a quoted body and an EDITABLE subject
  --- 5 · prospect panel ---
  ✓ 5.1   identity block, labels, and the three tabs
  ✓ 5.2   tabs switch to Attachments and Notes and back
  ✓ 5.3   agent card rows carry real values — 18 rows
  ✓ 5.4   card collapses and re-opens — 18 rows → 11 → 18
  ✓ 5.5   + Add email opens an inline form and cancels
  ✓ 5.6   + Add phone opens an inline form and cancels
  ✓ 5.7   copy writes to the clipboard
  ✓ 5.8   sequencing picker matches the thread's provider
  ✓ 5.9   panel resizes by drag and persists the width — 440 → 520, restored
  --- 6 · navigation ---
  ✓ 6.1   Next moves to the next conversation, Previous comes back
  ✓ 6.2   Back / Prev / Next preserve ?q= and ?page= (buildSuffix)
  ✓ 6.3   the thread rail is the tool's, restyled — and still works
  ✓ 6.4   Back returns to the conversation list

  40/40 checks passed
  no unexpected console errors, no unexpected failed requests
```

```
  ── 1440px ──   ✓ conversation · ✓ conversation + composer · ✓ inbox list · ✓ inbox archive
  ── 1280px ──   ✓ conversation · ✓ conversation + composer · ✓ inbox list · ✓ inbox archive
  ── 1100px ──   ✓ conversation · ✓ conversation + composer · ✓ inbox list · ✓ inbox archive
  12/12 measurements fit the viewport        (doc overflow 0px at every width)
```
