/*
 * TICKETS › OTHERS (24 Nov 2026). Eddy: "could you create a section called others and have the rest of the email go
 * through there? Reason being someone within a client's organization may message Amy, we don't want to miss anything."
 * Offered a narrow version (only people at a client's company) and this one; the user chose "Every other email".
 *
 * On: an email to a connected inbox from anyone who is neither a client address nor one of our team is kept too, as a
 * ticket with no client — the Others view — and a colleague writing inside a client's conversation joins that ticket.
 * Off (false): the rule before, "only emails from a client's address" (the user, 20 Nov) — sync.ts keeps that path, and
 * its tests still run against it.
 *
 * One switch, like analytics/instantly-switch.ts. Turning it off stops new Others mail; tickets already kept stay.
 */
export const TICKETS_OTHERS_ON: boolean = true;
