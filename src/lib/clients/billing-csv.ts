/*
 * The Billing tab's CSV downloads (19 Oct) — pure, tested.
 *
 * Text that a spreadsheet would run as a formula (=, +, -, @, tab, return
 * first) is written with a leading ' so it opens as text. Numbers stay
 * numbers, so a refund's −750 still adds up in a column.
 */

export type CsvCell = string | number | null | undefined;

export function csvText(header: string[], rows: CsvCell[][]): string {
  const cell = (v: CsvCell) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
