/*
 * TICKETS — the views the screen offers, and the search text clean-up. Pure, shared by the API and the screen.
 *
 * Research (Help Scout, Hiver, Front): Unassigned / Mine / everything open, with counts; the longest-waiting first
 * in the open views; Mine counts open work only.
 */

export const VIEWS = ["open", "mine", "unassigned", "waiting", "snoozed", "mentions", "done", "all", "others"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  open: "Open",
  mine: "Mine",
  unassigned: "Unassigned",
  waiting: "Waiting on client",
  snoozed: "Snoozed",
  mentions: "Mentions",
  done: "Done",
  all: "All",
  others: "Others",
};

export const VIEW_HINT: Record<View, string> = {
  open: "Every conversation where a client is waiting on us",
  mine: "Open and waiting tickets assigned to you",
  unassigned: "Open tickets nobody has picked up",
  waiting: "We replied, the client is up next",
  snoozed: "Back to Open when the snooze ends",
  mentions: "Tickets where a teammate @mentioned you in a note",
  done: "Finished conversations",
  all: "Every client conversation except those marked Not a ticket",
  others: "Every other email to a connected inbox: from anyone who isn't a client address or our team",
};

export const isView = (v: unknown): v is View => typeof v === "string" && (VIEWS as readonly string[]).includes(v);

/** A search box value safe to put inside a PostgREST or=() filter: no quotes, commas or brackets, 80 characters. */
export function cleanQuery(q: unknown): string {
  return String(q ?? "")
    .replace(/["\\,()*%:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** "#1042" or "1042" → 1042, for jumping straight to a ticket from the search box. */
export function ticketNumberIn(q: string): number | null {
  const m = /^#?(\d{1,9})$/.exec(q.trim());
  return m ? Number(m[1]) : null;
}

export interface SnoozePreset { id: string; label: string; until: string }

/** Snooze choices in Eastern time (the business's clock): later today, tomorrow 9am, Monday 9am, next week. */
export function snoozePresets(now = Date.now()): SnoozePreset[] {
  const et = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = (d: Date) => d.getTime() - et(d).getTime();
  const atEt = (base: Date, days: number, hour: number) => {
    const local = et(base);
    local.setDate(local.getDate() + days);
    local.setHours(hour, 0, 0, 0);
    return new Date(local.getTime() + offset(base));
  };
  const nowD = new Date(now);
  const day = et(nowD).getDay();
  const toMonday = ((8 - day) % 7) || 7;
  const out: SnoozePreset[] = [];
  const later = new Date(now + 3 * 3_600_000);
  if (et(later).getDate() === et(nowD).getDate()) out.push({ id: "later", label: "In 3 hours", until: later.toISOString() });
  out.push({ id: "tomorrow", label: "Tomorrow, 9 AM", until: atEt(nowD, 1, 9).toISOString() });
  out.push({ id: "monday", label: day === 0 || day === 6 ? "Monday, 9 AM" : "Next Monday, 9 AM", until: atEt(nowD, toMonday, 9).toISOString() });
  out.push({ id: "week", label: "In a week", until: atEt(nowD, 7, 9).toISOString() });
  return out;
}
