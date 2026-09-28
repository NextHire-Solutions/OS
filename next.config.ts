import type { NextConfig } from "next";

/*
 * Deliberately minimal, matching the sibling apps. Railway's Nixpacks build
 * runs `next build && next start`, and `next start` binds the injected $PORT
 * on 0.0.0.0 — so there is nothing to configure for the deploy target.
 *
 * No `output: "standalone"`: the family convention is a plain `next start`.
 */
const nextConfig: NextConfig = {
  experimental: {
    /*
     * How long a screen fetched by a hover prefetch may be shown on click.
     * The rail prefetches the FULL screen on hover (workspace.tsx) so the
     * click paints at once; Next's default would keep that for five minutes,
     * which is too long for an inbox or a pipeline. 30s is the minimum Next
     * allows. `dynamic` stays at its default of 0: a screen visited by a
     * click is always asked for again, never replayed.
     */
    staleTimes: { static: 30 },
  },
};

export default nextConfig;
