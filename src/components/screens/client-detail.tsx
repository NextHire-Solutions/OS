"use client";

import type { ClientRow } from "@/lib/clients/overview";

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

export function ClientDetail({ row, onClose }: { row: ClientRow; onClose: () => void }) {
  const { client, os, health, inbox, analytics, portalUrl } = row;
  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString() : null);

  return (
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
            <Row label="Market" value={os.record.market} owner="Master record" />
            <Row label="MLS" value={os.record.mls} owner="Master record" />
            <Row label="Area" value={os.record.area} owner="Master record" />
            <Row label="Timezone" value={health.timezone} owner="Client Health" />
            <Row label="Sender" value={os.record.sender} owner="Master record" />
            <Row label="Salesperson" value={os.record.salesperson} owner="Master record" />
            <Row label="Account Manager" value={os.record.accountManager} owner="Master record" />
            <Row label="Brokerage" value={os.contact.brokerage} owner="Master record" />
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
            <Row label="MLS / location" value={os.record.mls ?? os.record.area} owner="Master record" />
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
    </div>
  );
}
