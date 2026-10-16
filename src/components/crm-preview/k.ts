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

/*
 * A control that would change something, drawn exactly as the design draws it
 * (not greyed out — the preview is for seeing the design as delivered) and
 * inert: the preview's frame catches the click and says it is read-only
 * (crm-preview.tsx). Controls the design itself shows disabled — the bulk bar
 * with nothing ticked, Connect with no key — stay `disabled`.
 */
export const RO = { "aria-disabled": true, "data-ro": "", title: READ_ONLY } as const;
