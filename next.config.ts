import type { NextConfig } from "next";

/*
 * Deliberately minimal, matching the sibling apps. Railway's Nixpacks build
 * runs `next build && next start`, and `next start` binds the injected $PORT
 * on 0.0.0.0 — so there is nothing to configure for the deploy target.
 *
 * No `output: "standalone"`: the family convention is a plain `next start`.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
