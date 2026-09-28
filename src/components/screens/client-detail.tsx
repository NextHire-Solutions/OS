"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

import type { ClientRow } from "@/lib/clients/overview";

import { MarketsPanel } from "./markets-panel";

/*
 * One client, every field the master record holds — §6 made visible.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SHOWS THE OWNER OF EVERY FIELD
 *
 * §7 asks, for every piece of client information: where does it originate,
 * where can it be edited, which tools consume it. That answer has existed
 * since the data dictionary was written, and it lived in a markdown file
 * nobody opens mid-conversation. Putting the owner beside the value turns the
 * dictionary into something you read while looking at the client it describes.
 *
 * It also explains the screen's own behaviour. "Plan · Client Health" is why
 * editing the plan here writes to that tool rather than copying the value onto
 * the master record — which §5 lists as the thing not to do.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY FIELD IS SHOWN, NOT HIDDEN
 *
 * Account Manager is recorded for 0 of 52 clients. A view that quietly omitted
 * blank fields would make that look like a complete record, when the gap IS
 * the finding — §5's worked example ("change the account manager once and
 * every tool updates") cannot be demonstrated at all until these are filled
 * in. So every field in §6 appears, and the empty ones say so.
 */

const money = (n: number | null) => (n === null ? null : `$${n.toLocaleString()}`);

function Row({ label, value, owner }: { label: string; value: unknown; owner: string }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="cd-row">
      <span className="cd-label">{label}</span>
      <span className={empty ? "cd-value cd-empty" : "cd-value"}>
        {empty ? "not set" : String(value)}
      </span>
      <span className="cd-owner">{owner}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="cd-section">
      <div className="cd-head">
        <h4>{title}</h4>
        {note ? <span className="mut">{note}</span> : null}
      </div>
      <div className="cd-rows">{children}</div>
    </section>
  );
}

/*
 * RENDERED INTO document.body, NOT WHERE IT IS CALLED FROM.
 *
 * The roster opens this from inside a table row (<tr>). A <div> there is
 * invalid HTML, and two visible bugs followed from it (reported 28 Sep):
 *
 *   - the browser treated the dialog's box as an extra first cell, so the row
 *     that had been opened shifted every column one place to the right;
 *   - `position: fixed` pins to the nearest transformed/clipped ancestor rather
 *     than the viewport, so the dialog opened at the TOP of the page and anyone
 *     who had scrolled down to a client had to scroll back up to see it.
 *
 * A portal takes it out of the table entirely, so it is always centred on the
 * screen the person is looking at, wherever it is opened from.
 */
export function ClientDetail({ row, onClose }: { row: ClientRow; onClose: () => void }) {
  const { client, os, health, inbox, analytics, portalUrl } = row;
  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString() : null);

  // Escape closes, and the page behind does not scroll while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="cd-backdrop" role="dialog" aria-modal="true" aria-label={`${client.name} — full record`} onClick={onClose}>
      <div className="cd-panel" onClick={(e) => e.stopPropagation()}>
        <header className="cd-top">
          <div>
            <h3>{client.name}</h3>
            <span className="mut">
              {os.status}
              {os.statusSince?.at ? ` since ${date(os.statusSince.at)}` : ""}
              {(client.aliases ?? []).length ? ` · also known as ${(client.aliases ?? []).join(", ")}` : ""}
            </span>
          </div>
          <button className="ib" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="cd-body">
          <Section title="Client Information" note="§6">
            <Row label="Client ID" value={os.id} owner="Master record" />
            <Row label="Client name" value={client.name} owner="Master record" />
            <Row label="Status" value={os.status} owner="Master record" />
            <Row label="Plan" value={health.plan} owner="Client Health" />
            <Row label="Start date" value={date(health.startDate)} owner="Client Health" />
            <Row label="Status set on" value={date(os.statusSince?.at ?? null)} owner="Master record" />
            <Row label="Timezone" value={health.timezone} owner="Client Health" />
            <Row label="Sender" value={os.record.sender} owner="Master record" />
            <Row label="Salesperson" value={os.record.salesperson} owner="Master record" />
            <Row label="Account Manager" value={os.record.accountManager} owner="Master record" />
            <Row label="Brokerage" value={os.contact.brokerage} owner="Master record" />
          </Section>

          {/*
            * Markets are a LIST, not three fields.
            *
            * They sat in Client Information as three single values until
            * migration 0017, which could describe one market per client — and a
            * client covering Boston and Florida has to be describable. This
            * section is editable in place because it is the one part of §6 the
            * client asked to manage themselves.
            */}
          <Section
            title="Markets, MLS & Areas"
            note="§6 · a client may cover several — each can carry its own campaigns"
          >
            {/*
              * `os.id` is nullable: a client can appear here from a tool while
              * having no master-record row yet. Markets hang off that row, so
              * there is nowhere to put them until it exists — say that, rather
              * than render a form whose every save would 404.
              */}
            {os.id ? (
              <MarketsPanel clientId={os.id} />
            ) : (
              <p className="cd-empty">
                This client has no master record yet, so markets cannot be recorded.
                Adopt it into the OS client list first.
              </p>
            )}
          </Section>

          <Section title="People" note="§6 · Master Inbox owns these — edit them in the People panel">
            <Row label="Introduce to" value={os.contact.name} owner="Master record" />
            <Row label="Their role" value={os.contact.role} owner="Master record" />
            <Row label="Their email" value={os.contact.email} owner="Master record" />
            <Row label="Team, agents & DNC" value="see the People panel on the row" owner="Master Inbox" />
          </Section>

          <Section title="Billing Information" note="§6, §12">
            <Row label="Billing interval" value={health.billingInterval} owner="Client Health" />
            <Row label="Billing anchor date" value={date(health.billingAnchorDate)} owner="Client Health" />
            <Row label="Next billing date" value={date(health.nextBillingDate)} owner="derived" />
            <Row label="Stripe Customer ID" value={os.record.stripeCustomerId} owner="Master record" />
            <Row label="Stripe Subscription ID" value={os.record.stripeSubscriptionId} owner="Master record" />
          </Section>

          <Section title="Campaign Information" note="§6">
            <Row label="Campaigns" value={analytics.campaigns} owner="Analytics" />
            <Row label="Emails sent" value={analytics.sent?.toLocaleString() ?? null} owner="Analytics" />
            <Row label="Campaign aliases" value={(client.aliases ?? []).join(", ") || null} owner="Master record" />
            {/*
              * Points at the Markets section rather than repeating one value.
              *
              * This row used to read `mls ?? area` off the master record, which
              * silently showed ONE of a client's markets and hid the rest —
              * exactly the wrong impression on the panel that explains which
              * campaigns a client runs, since campaigns follow markets.
              */}
            <Row
              label="MLS / location"
              value="see Markets, MLS & Areas above"
              owner="Master record"
            />
            <Row label="Sender" value={os.record.sender} owner="Master record" />
          </Section>

          <Section title="Performance & Targets" note="§6">
            <Row label="Weekly introduction target" value={health.weeklyTarget} owner="Client Health" />
            <Row label="Monthly introduction target" value={health.monthlyTarget} owner="Client Health" />
            <Row label="Introductions delivered" value={inbox.intros} owner="Master Inbox" />
            <Row label="Last introduction" value={date(inbox.lastIntro)} owner="Master Inbox" />
          </Section>

          <Section title="Where this client exists" note="§16 · the Consistency screen explains any absence">
            <Row label="Master Inbox" value={inbox.present ? "yes" : "no row"} owner="tool" />
            <Row label="Client Health" value={health.present ? "yes" : "no row"} owner="tool" />
            <Row label="Analytics" value={analytics.present ? "yes" : "no row"} owner="tool" />
            <Row label="Database / Onboarding" value={os.inOnboarding ? "yes" : "no row"} owner="tool" />
            <Row label="Client portal" value={portalUrl ? "has a portal" : "none"} owner="Master Inbox" />
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
