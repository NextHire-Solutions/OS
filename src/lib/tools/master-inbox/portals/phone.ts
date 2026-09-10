// Single source of truth for phone-number formatting across the
// portal lists (DNC, Your Agents, Team). The client asked for
// "(XXX) XXX-XXXX" everywhere — applied at render time so we don't
// have to migrate stored values. Leaves international or otherwise
// non-10-digit values alone so we don't truncate or corrupt them.

export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return "—";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // 11-digit US (includes leading country code "1").
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Anything else (international, extensions, partials) is rendered
  // verbatim — the goal is consistent US formatting, not enforcement.
  return raw.trim();
}
