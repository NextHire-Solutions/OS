/** Tiny shared formatting helpers — the tool's `lib/format.ts`, minus the env reader (see env.ts). */

export const firstName = (n?: string | null): string => (n ?? "").trim().split(/\s+/)[0] ?? "";
