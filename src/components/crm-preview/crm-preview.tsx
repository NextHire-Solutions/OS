"use client";

/*
 * The redesign's frame — the bar that says this is a preview, the design's
 * sidebar, and whichever page is open. See src/app/crm-preview/page.tsx for
 * who may see it and why it is read-only.
 */

import { useMemo, useState } from "react";

import type { PipelineEntry, TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { initials, type PreviewStage, type PreviewView } from "@/lib/crm-preview/model";

import { Icon, type IconName } from "./icons";
import { k } from "./k";
import { PipelineScreen } from "./pipeline";
import { DncScreen, IntegrationsScreen, MyAgentsScreen, TeamScreen } from "./pages";
import { MarketScreen, ReportsScreen } from "./market";
import { CampaignsScreen, HelpScreen } from "./static-pages";
import logo from "./brokerstaffer-logo.png";

export interface PreviewClient {
  id: string;
  name: string;
  token: string;
  fubConnected: boolean;
}

type RailItem = { view: PreviewView | "billing"; label: string; icon: IconName; badge?: string };

const RAIL: Array<{ section: string; items: RailItem[] }> = [
  { section: "Workspace", items: [
    { view: "pipeline", label: "Pipeline", icon: "pipeline" },
    { view: "reports", label: "Reports", icon: "reports" },
    { view: "campaigns", label: "Campaigns", icon: "campaigns", badge: "Soon" },
  ] },
  { section: "Agents", items: [
    { view: "market", label: "Market", icon: "search" },
    { view: "prospects", label: "Prospects", icon: "target" },
    { view: "agents", label: "My Agents", icon: "users" },
    { view: "dnc", label: "DNC List", icon: "ban" },
  ] },
  { section: "Account", items: [
    { view: "team", label: "Team", icon: "user" },
    { view: "integrations", label: "Integrations", icon: "plug" },
    { view: "billing", label: "Billing", icon: "card" },
    { view: "help", label: "Help", icon: "help" },
  ] },
];

export function CrmPreview({
  client,
  portals,
  stages,
  furthest,
  entries,
  agents,
  dnc,
  team,
  initialView,
  now,
}: {
  client: PreviewClient;
  portals: Array<{ id: string; name: string }>;
  stages: PreviewStage[];
  /** For agents in Nurture / Not a Fit / No Response: the furthest forward stage on record. */
  furthest: Record<string, string>;
  entries: PipelineEntry[];
  agents: AgentEntry[];
  dnc: DncEntry[];
  team: TeamMember[];
  initialView: PreviewView;
  now: string;
}) {
  const [view, setView] = useState<PreviewView>(initialView);
  const [collapsed, setCollapsed] = useState(false);
  // The server's clock, so the first draw in the browser matches the server's.
  const today = useMemo(() => new Date(now), [now]);

  const hrefFor = (v: PreviewView) => `/crm-preview?client=${encodeURIComponent(client.id)}&view=${v}`;
  const go = (v: PreviewView) => {
    setView(v);
    window.history.replaceState(null, "", hrefFor(v));
    window.scrollTo(0, 0);
  };

  return (
    <>
      <div className="cpv-bar" role="note">
        <span className="cpv-tag">PREVIEW</span>
        <b>New client portal design</b>
        <span className="cpv-note">Read-only · visible to Owners only · {client.name}&apos;s live portal is unchanged</span>
        <span className="cpv-right">
          <select
            id="cpv-client"
            aria-label="Preview another client"
            value={client.id}
            onChange={(e) => window.location.assign(`/crm-preview?client=${encodeURIComponent(e.target.value)}`)}
          >
            {portals.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <a href="/">Back to the OS</a>
        </span>
      </div>

      <div className={k("app")}>
        <nav className={k(collapsed ? "rail cl" : "rail")} aria-label="Main">
          <div className={k("lg")}>
            <span className={k("lw")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-size logo, as the design draws it */}
              <img src={logo.src} alt="BrokerStaffer" style={{ width: 104, height: 32, objectFit: "contain", objectPosition: "left" }} />
            </span>
            <button
              type="button"
              className={k("col")}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setCollapsed((c) => !c)}
            >
              <Icon name="sidebar" />
            </button>
          </div>
          {RAIL.map((group) => (
            <div key={group.section} style={{ display: "contents" }}>
              <div className={k("sl")}>{group.section}</div>
              {group.items.map((item) => {
                if (item.view === "billing") {
                  // The client's Stripe page in the design; nothing to open from a preview.
                  return (
                    <span key="billing" className={k("ri")} title="Billing opens the client's Stripe page — not in this preview" aria-disabled="true">
                      <Icon name={item.icon} size={17} />
                      <span className={k("t")}>{item.label}</span>
                      <span className={k("ex")}><Icon name="external" size={13} /></span>
                    </span>
                  );
                }
                const v = item.view;
                const on = view === v;
                return (
                  <a
                    key={v}
                    className={k(on ? "ri on" : "ri")}
                    href={hrefFor(v)}
                    title={item.label}
                    aria-current={on ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      go(v);
                    }}
                  >
                    <Icon name={item.icon} size={17} />
                    <span className={k("t")}>{item.label}</span>
                    {item.badge ? <span className={k("bd")}>{item.badge}</span> : null}
                  </a>
                );
              })}
            </div>
          ))}
          <div className={k("ft")}>
            <div className={k("usr")}>
              <i>{initials(client.name)}</i>
              <span>
                {client.name}
                <small>Portal preview</small>
              </span>
            </div>
          </div>
        </nav>

        <div className={k("main")}>
          {view === "pipeline" ? (
            <PipelineScreen entries={entries} stages={stages} furthest={furthest} token={client.token} now={today} />
          ) : view === "market" || view === "prospects" ? (
            <MarketScreen key={view} clientId={client.id} list={view} />
          ) : view === "reports" ? (
            <ReportsScreen clientId={client.id} entries={entries} />
          ) : view === "campaigns" ? (
            <CampaignsScreen />
          ) : view === "help" ? (
            <HelpScreen />
          ) : view === "agents" ? (
            <MyAgentsScreen agents={agents} />
          ) : view === "dnc" ? (
            <DncScreen dnc={dnc} />
          ) : view === "team" ? (
            <TeamScreen team={team} />
          ) : (
            <IntegrationsScreen fubConnected={client.fubConnected} />
          )}
        </div>
      </div>
    </>
  );
}
