# Agent Search: the app stays live as a headless worker

**Decided 11 Sep 2026 by the account owner.**

Agent Search is the one tool that does NOT fully move into the OS, and the split
is deliberate:

| half | where it lives | who opens it |
|---|---|---|
| the five screens | **the OS** | staff, daily |
| the scraper worker | **the deployed Agent Search app** | nobody |

The app keeps running. Its UI is simply never visited — the OS is the only
control surface. From a user's point of view Agent Search is "switched off";
mechanically it is plumbing, like a database.

## Why the worker did not move

Four reasons, in order of weight:

1. **Shared failure domain.** Today a stuck scrape and a broken inbox cannot
   affect each other. Merged, they can: a bug in the workspace could stop
   scraping, and a wedged Chromium could slow the workspace.
2. **`const jobs = new Map()`** (`web/server/jobs.js:11`) — running scrapes live
   in one container's memory. Inside the OS, every deploy would kill scrapes in
   flight. Fixing that properly means a durable job store, which is a project of
   its own.
3. **Chromium in the image.** `web/Dockerfile` runs
   `npx playwright install --with-deps chromium`. That is roughly a gigabyte on
   every OS deploy, on a user-facing app where deploy speed matters.
4. **Credentials.** Nine Courted logins and Bright Data keys would move into the
   workspace's environment for no gain.

## What this means in practice

- **Do not delete the Agent Search Railway service.** Its UI is dead weight and
  can be removed; the worker cannot.
- The OS's Agent Search routes PROXY 16 of 19 endpoints to it. Those are not
  unfinished work — they are the correct shape, because a Next route handler
  cannot hold a browser session or an in-memory job.
- Three endpoints are native to the OS (`/columns`, `/enrich/resolve`, and the
  pure builders), and the scraping LOGIC is ported verbatim: a differential test
  runs the tool's own `merge.js`, `sheet-source.js` and `profile-parser.js`
  against the TypeScript port on identical input — 48/48 identical.

## If this is ever revisited

Full absorption needs, in this order: a durable job store, Chromium in the OS
image, and acceptance that deploys interrupt scrapes. Do it after the other
tools are finished, not before.

## Two live bugs found while porting, NOT introduced by it

- `courted_agents`, `zillow_agents` and `realtor_agents` **do not exist**.
  `web/server/db.js` has been failing silently on every scrape for months; the
  real write path is the ingest webhook to the Database app. `schema.sql` is
  wrong.
- **Import de-dupe is literal, not canonical.** `www.` and non-`www.` versions of
  the same profile are scraped and billed twice, even though `normalizeUrl`
  exists and would collapse them. Reproduced deliberately in the OS and pinned
  with a test, because the preview count must match what the service actually
  runs — fixing it in the OS alone would make the two disagree.
