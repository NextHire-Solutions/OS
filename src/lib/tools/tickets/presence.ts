/*
 * TICKETS — who has a ticket open right now ("Amy is viewing"). Research (Help Scout, Hiver): indicators, never
 * locks. In memory, per process: a page open on the ticket says so every 15 seconds; 40 seconds of silence and the
 * viewer is gone. A deploy forgets everyone for a moment, which is harmless.
 */

const TTL_MS = 40_000;
type Seen = Map<string, Map<string, number>>;
const seen: Seen = ((globalThis as Record<symbol, unknown>)[Symbol.for("os.tickets.presence")] ??= new Map()) as Seen;

export function touch(ticketId: string, email: string, now = Date.now()) {
  let m = seen.get(ticketId);
  if (!m) seen.set(ticketId, (m = new Map()));
  m.set(email.toLowerCase(), now);
}

export function leave(ticketId: string, email: string) {
  seen.get(ticketId)?.delete(email.toLowerCase());
}

/** Who else has this ticket open. */
export function viewers(ticketId: string, except: string | null, now = Date.now()): string[] {
  const m = seen.get(ticketId);
  if (!m) return [];
  const out: string[] = [];
  for (const [email, at] of m) {
    if (now - at > TTL_MS) { m.delete(email); continue; }
    if (email !== except?.toLowerCase()) out.push(email);
  }
  return out.sort();
}

export function viewersFor(ids: readonly string[], except: string | null, now = Date.now()): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const v = viewers(id, except, now);
    if (v.length) out[id] = v;
  }
  return out;
}
