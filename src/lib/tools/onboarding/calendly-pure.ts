/*
 * What a Calendly webhook body means, before anything is written. Ported from
 * the tool's `app/api/webhooks/calendly/route.ts`.
 */

export type CalendlyDecision =
  | { ignored: string }
  | { event: "invitee.created" | "invitee.canceled"; email: string; startTime: string | null; eventName: string | null };

export function calendlyDecision(body: unknown, wantType: string | undefined): CalendlyDecision {
  const b = (body ?? {}) as Record<string, unknown>;
  const event = String(b.event ?? "");
  if (event !== "invitee.created" && event !== "invitee.canceled") {
    return { ignored: event || "unknown" };
  }
  const p = (b.payload ?? {}) as Record<string, unknown>;
  const scheduled = (p.scheduled_event ?? {}) as Record<string, unknown>;

  // Only the onboarding setup-call event counts — the org webhook fires for ALL
  // event types (demo, discovery, touchbase...), which must not touch onboarding_date.
  if (wantType && scheduled.event_type !== wantType) return { ignored: "other event type" };

  const email = String(p.email ?? "").trim();
  if (!email) return { ignored: "no invitee email" };

  return {
    event,
    email,
    startTime: typeof scheduled.start_time === "string" ? scheduled.start_time : null,
    eventName: typeof scheduled.name === "string" ? scheduled.name : null,
  };
}
