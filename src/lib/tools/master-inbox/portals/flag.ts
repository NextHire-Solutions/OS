// Master switch for the Client Portals feature.
//
// Driven by the CLIENT_PORTALS_ENABLED env var so local and production
// can differ without a code edit:
//   - Local: set CLIENT_PORTALS_ENABLED=true in .env.local → portals on.
//   - Production (Railway): the var is unset → false → every portal
//     route renders "Coming soon" and returns BEFORE any query that
//     touches the portal_token / portal_enabled columns.
//
// To go live in production, set CLIENT_PORTALS_ENABLED=true on the
// Railway service. Server-only — every consumer is a server component
// or route handler, so a non-public env var is fine.
export const CLIENT_PORTALS_ENABLED = process.env.CLIENT_PORTALS_ENABLED === "true";
