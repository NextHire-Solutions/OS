/*
 * POST /api/crm-preview/demo — the new portal's first save address (21 Oct), kept so a page opened before 28 Oct
 * still saves: it is /api/crm-preview/save, which now serves the Demo Portal and a real portal's own client alike.
 */
export { POST } from "../save/route";

// Route settings are read from this file itself (Next does not follow a re-export for them).
export const dynamic = "force-dynamic";
export const maxDuration = 120;
