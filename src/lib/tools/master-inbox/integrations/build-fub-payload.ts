import type { PipelineEntry } from "../portals/portal-data";
import type { FubPerson } from "../integrations/followup-boss";
import {
  pickFirstString,
  PHONE_KEYS,
} from "../portals/custom-field-helpers";

// Build the FUB person payload for a pipeline entry.
//
// Per user direction (2026-06-16), the payload is intentionally minimal:
// only the standard FUB person fields — firstName / lastName, emails,
// phones — plus the BrokerStaffer tag. Source is set at the EVENT
// layer (not here) in lib/integrations/followup-boss.ts pushPersonEvent
// (`source: "BrokerStaffer"` on the event body).
//
// Every richer custom-field mapping (Brokerage, Office City, MLS,
// sales-volume, GCI, profile URLs, Introduction Date, etc.) was
// removed by request — clients didn't want them syncing. The pickStr
// + collectProfileUrls helpers went with them. Re-introducing custom
// fields later is a matter of `git log` + re-export.
//
// FUB accepts sparse payloads and won't error on missing data
// (verified against the live API), but we still trim empties so we
// never overwrite a real value in FUB with our null.

const REQUIRED_TAG = "BrokerStaffer";

export function buildFubPayload(entry: PipelineEntry): FubPerson {
  const person: FubPerson = {};

  // -- Name --
  const { firstName, lastName } = splitName(entry.lead_name);
  if (firstName) person.firstName = firstName;
  if (lastName) person.lastName = lastName;

  // -- Email --
  if (entry.lead_email && entry.lead_email.includes("@")) {
    person.emails = [{ type: "work", value: entry.lead_email.trim() }];
  }

  // -- Phone --
  // Snapshot column `entry.lead_phone` is the primary source (the
  // portal Edit dialog writes to it and the intro-label trigger
  // pre-fills it from custom_fields.phone / Phone). But EmailBison
  // campaigns store phone under "phone number" (lowercase, with a
  // space) which the trigger does NOT recognise, so 89 pipeline
  // entries currently have lead_phone NULL while the real number
  // sits in leads.custom_fields untouched. Fall back to the same
  // widened key list the pipeline-board display already uses.
  // Same shape as commit 9536473 (2026-06-27) on the display side.
  const cf =
    ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
      ?.custom_fields ?? {}) as Record<string, unknown>;
  const phone = entry.lead_phone || pickFirstString(cf, PHONE_KEYS);
  if (phone && phone.trim()) {
    person.phones = [{ type: "mobile", value: phone.trim() }];
  }

  // -- Tags --
  // Always tag with BrokerStaffer so the client can filter / build
  // smart lists on it inside FUB.
  person.tags = [REQUIRED_TAG];

  return person;
}

// Split "First Last" or "First Middle Last" into firstName + lastName.
// Single-word names go entirely into firstName (FUB tolerates that).
function splitName(
  full: string | null,
): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}
