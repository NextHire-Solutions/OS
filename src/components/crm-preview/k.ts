/** The design's class names as crm-preview.css prefixes them: k("btn pri") → "crx-btn crx-pri". */
export function k(names: string): string {
  return names
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => `crx-${n}`)
    .join(" ");
}

/** The title on every control that would change something. */
export const READ_ONLY = "Read-only preview — this would change the client's portal";
