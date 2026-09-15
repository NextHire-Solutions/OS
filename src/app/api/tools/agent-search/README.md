Agent Search's routes.

Two kinds, and the difference is the whole design:

  PROXIED   Everything that needs the scraper — a headless Chromium behind a
            Bright Data unblocker, nine stored Courted logins, a Railway API
            token, and jobs held in one container's memory. These forward to
            SCRAPER_URL shape-for-shape and pass the upstream status and its
            {error} message straight back, because those messages ("Courted
            login failed — check the credentials") are the answer the operator
            needs. See ../../../lib/tools/agent-search/scraper.ts.

  NATIVE    courted-state, which reads mls_monitor_state and refresh_state out
            of Agent Search's own Supabase. The tool writes both daily and
            displays neither. Accounts are the union of the two tables, plus
            the configured count from the live /api/status.

Two of the proxied routes are FIRE-AND-POLL rather than pass-through:
courted/refresh and courted/mls-monitor. Their upstream handlers resolve only
when a multi-hour sweep finishes, so these answer 202 {started:true} after a
short early-refusal window and the screens watch courted-state for the row
the scheduler writes. See lib/tools/agent-search/scraper.ts fireScraper.

Every handler sits behind the workspace session. The live service is currently
open (BS_SSO_SECRET unset on Railway), so this is a tightening.
