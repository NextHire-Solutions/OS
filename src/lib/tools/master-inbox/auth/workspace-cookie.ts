/*
 * The cookie the workspace switcher writes.
 *
 * The tool exports this from `lib/auth/workspace.ts`. Here that module is the
 * OS's own shim (src/lib/auth/workspace.ts) and is not this tool's to edit, so
 * the constant lives beside the tool's other auth helpers instead. Same name,
 * same value.
 *
 * Retained for back-compat with any caller still importing this constant.
 * No longer set or read in the codebase — single-tenant has no concept
 * of an "active" workspace to remember.
 */
export const WORKSPACE_COOKIE = "active_workspace";
