# Agent Search — wiring

**Status: step 1 is DONE — you wired all five screens into `page.tsx` while this
port was finishing, exactly as designed.** Both test scripts were then repointed
from the temporary harness to the real routes (`/search`, `/search/master`,
`/search/accounts`, `/search/mls`, `/search/import`) and pass there — 37/37 UI
checks and 15/15 layout checks through the real shell. The harness has been
deleted.

What remains is step 2 (four `verified` flags), the decision in step 1's second
half, and two optional items. Nothing below changes behaviour for any other
tool.

---

## 1. `src/app/[[...slug]]/page.tsx` — the screen map  ✅ DONE

All five are wired (lines 23–27 and 261–265) and all five routes serve HTTP 200.
Nothing further is needed here.

### One loose end you introduced, and it is harmless but wasteful

`AgentSearchScreen` is still imported on line 22 and `getAgentSearchOverview` on
line 8, but neither is used any more — `"search:search"` now renders
`AgentSearchSearchScreen`. Line 162 therefore still runs:

```tsx
    only("search:search") ? getAgentSearchOverview() : Promise.resolve(null),
```

which makes **four Supabase round trips** (three exact counts over 1.17M, 178K and
54 rows, plus the saved-lists read) on every visit to `/search`, and throws the
result away. `tsc` does not flag it because the import is still referenced by the
`agentSearch` variable that feeds it.

The fix depends on the decision below, so it is left to you.

### The existing `AgentSearchScreen` — a decision is needed

`src/components/screens/agent-search/agents.tsx` is currently what `search:search`
renders. It is a browser for the `agents` / `offices` / `mls` / `saved_lists`
tables — **and those belong to `NextHire-Solutions/Databaseproject`, a different
product.** The Agent Search scraper never reads them; it only writes to them
through the ingest webhook. So it is not one of Agent Search's five screens.

It works and it is genuinely useful (1.17M agents, server-paged). It has been
**left exactly as it is** — not deleted, not moved. Three options:

- **(a) Keep it as a sixth leaf.** Add to `nav.ts` under the `search` product,
  and add `"search:agents": <AgentSearchScreen initial={agentSearch} />` to the
  map. The `getAgentSearchOverview()` server load on line 158 then changes its
  `only("search:search")` guard to `only("search:agents")`.
- **(b) Give it its own product** once `DATABASE_APP_URL` is filled in — it is
  the Database app's front end, not Agent Search's.
- **(c) Drop it**, along with `agents.ts`, `api/tools/agent-search/route.ts` and
  `api/tools/agent-search/agents/route.ts`.

If **(c)**, also remove `agentSearch` from the `Promise.all` on line 150 and the
`getAgentSearchOverview` import on line 8. If **(a)** or **(b)**, nothing else
changes — those three files are untouched and still work.

---

## 2. `src/lib/workspace/nav.ts` — mark the four leaves verified

The four unverified leaves now have real screens. Their `path` values are
vestigial — they were paths *into the live tool*, and nothing embeds it any
more — but leaving them costs nothing and `pathForId` ignores them.

```tsx
        children: [
          { id: "search",   label: "Search",              path: "/", verified: true },
          { id: "master",   label: "Master List",         path: "/", verified: true },
          { id: "accounts", label: "Courted accounts",    path: "/", verified: true },
          { id: "mls",      label: "MLS monitor",         path: "/", verified: true },
          { id: "import",   label: "Import Profile URLs", path: "/", verified: true },
        ],
```

The comment above them ("One long scrolling page today… so these are unverified
on purpose and every one lands on the same page for now") is now wrong and
should go. Suggested replacement:

```tsx
          // The live tool is one long scrolling page. Each of these is a real
          // section of it, now a destination of its own — so the rail can link
          // straight to the MLS monitor and the back button behaves.
```

If you take option **(a)** above, add:

```tsx
          { id: "agents", label: "Agent database", path: "/", verified: true },
```

---

## 3. The preview harness  ✅ DONE — deleted

`src/app/agent-search-preview/` existed only so the screens could be driven in a
real browser before they were routed. Now that they are, it has been removed and
both test scripts drive the real addresses instead:

```
  node scripts/agent-search-ui-test.mjs        37 passed, 0 failed
  node scripts/agent-search-layout-test.mjs    15/15 screen×width combinations fit
```

---

## 4. `.env.local` — nothing required, one thing optional

Already present and sufficient:

```
SCRAPER_URL=https://search.brokerstaffer.com
AGENT_SEARCH_SUPABASE_URL=…
AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY=…
```

**Optional.** The live service has an `ADMIN_TOKEN` gate on the four mutating
Courted routes. It is **not set on Railway**, so nothing is gated today. If it
is ever set there, add the same value here and it is forwarded automatically:

```
AGENT_SEARCH_ADMIN_TOKEN=…
```

No new secret is introduced by this port.

---

## 5. `src/app/workspace.css` — one optional addition

Not required; every screen fits and passes the layout test as-is. The `.as-*`
family had no consumers before this port, and two things are currently done
with inline styles that would read better as classes if you want them:

```css
/* An options group inside the search card. */
.as-opt{border:1px solid var(--line);border-radius:12px;padding:16px;
        display:grid;gap:12px;align-content:start;background:var(--inset)}
.as-opt-h{display:flex;align-items:center;gap:8px;font-size:13px;
          font-weight:600;color:var(--ink)}
.as-opt-h i{width:9px;height:9px;border-radius:50%;display:block}

/* MLS added / removed badges. */
.as-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px}
.as-badge.add{color:var(--green);background:var(--green-pale)}
.as-badge.rem{color:var(--red);background:var(--red-pale)}
```

---

## What this port did NOT touch

- `src/app/[[...slug]]/page.tsx`, `src/lib/workspace/nav.ts`
- `src/app/globals.css`, `workspace.css`, `inbox-theme.css`, `mi-skin.css`
- anything under `src/components/master-inbox/`,
  `src/components/screens/master-inbox/`, `src/lib/tools/master-inbox/`,
  `src/app/api/tools/master-inbox/`
- `src/components/screens/agent-search/agents.tsx` and its two routes — left
  working, pending the decision in step 1
- anything outside `/Users/sankalpdutt/Desktop/Code/brokerstaffer-os`. The
  scraper clone at `_os-sources/scrapper` was read only.

No commit, no push. No secret added to a tracked file.
