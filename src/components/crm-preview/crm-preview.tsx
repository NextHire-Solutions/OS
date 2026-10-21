"use client";

/*
 * The redesign's frame — the bar that says this is a preview, the design's
 * sidebar, and whichever page is open. See src/app/crm-preview/page.tsx for
 * who may see it and why it is read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { PipelineEntry, TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { initials, type PreviewStage, type PreviewView } from "@/lib/crm-preview/model";

import { Icon, type IconName } from "./icons";
import { k, RO } from "./k";
import { ChatWindow } from "./chat";
import { DemoContext, postDemo, type DemoAction } from "./demo-save";
import { SetupWizard } from "./setup";
import { PipelineScreen } from "./pipeline";
import { DncScreen, IntegrationsScreen, MyAgentsScreen, TeamScreen } from "./pages";
import { MarketScreen, ReportsScreen } from "./market";
import { CampaignsScreen, HelpScreen } from "./static-pages";
import logo from "./brokerstaffer-logo.png";

export interface PreviewClient {
  id: string;
  name: string;
  /** The Demo Portal: its buttons save (21 Oct). Every other client is read-only. Decided on the server. */
  demo: boolean;
  fubConnected: boolean;
  /** The client's main contact (os_clients.contact_name), shown where the design shows the signed-in person. */
  contactName: string | null;
  /** The client record's areas (else MLS), for the Setup wizard's welcome line. */
  coverage: string | null;
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
  initialStep,
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
  initialStep: number;
  now: string;
}) {
  const [view, setView] = useState<PreviewView>(initialView);
  const [step, setStep] = useState(initialStep);
  const [chat, setChat] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // What the page shows is explained up here, in the preview's own bar — never inside the design.
  const [context, setContext] = useState<string | null>(null);
  // The note a read-only control gives when it is clicked — and, on the Demo Portal, what a save did.
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const flash = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), bad ? 5000 : 2600);
  }, []);
  const router = useRouter();
  const save = useCallback(
    async (action: DemoAction) => {
      if (!client.demo) return false;
      const r = await postDemo(client.id, action);
      if (!r.ok) {
        flash(r.error, true);
        return false;
      }
      flash("Saved on the Demo Portal.");
      router.refresh();
      return true;
    },
    [client.demo, client.id, flash, router],
  );
  const demo = useMemo(() => ({ live: client.demo, save }), [client.demo, save]);
  /*
   * Every control that would change something carries data-ro (k.ts RO): it is
   * drawn as the design draws it, and its click stops here — before any
   * handler, a checkbox toggle or a link — with a note instead.
   */
  const onClickCapture = (e: React.MouseEvent) => {
    if (!(e.target as Element).closest?.("[data-ro]")) return;
    e.preventDefault();
    e.stopPropagation();
    flash(client.demo ? "Not built yet on the Demo Portal — this one is drawn only." : `Read-only preview — nothing here changes ${client.name}'s portal.`);
  };
  // The server's clock, so the first draw in the browser matches the server's.
  const today = useMemo(() => new Date(now), [now]);

  const hrefFor = (v: PreviewView) => `/crm-preview?client=${encodeURIComponent(client.id)}&view=${v}`;
  const go = (v: PreviewView) => {
    setView(v);
    setContext(null);
    window.history.replaceState(null, "", v === "setup" ? `${hrefFor(v)}&step=${step}` : hrefFor(v));
    window.scrollTo(0, 0);
  };
  const goStep = (n: number) => {
    setStep(n);
    window.history.replaceState(null, "", `${hrefFor("setup")}&step=${n}`);
    window.scrollTo(0, 0);
  };
  const toastNote = toast ? <div className={toast.bad ? "cpv-toast cpv-bad" : "cpv-toast"} role={toast.bad ? "alert" : "status"}>{toast.text}</div> : null;

  return (
    <DemoContext.Provider value={demo}>
      <div className="cpv-bar" role="note">
        <span className="cpv-tag">PREVIEW</span>
        <b>New client portal design</b>
        {client.demo ? (
          <span className="cpv-note">Working copy · private · saves change the Demo Portal&apos;s own records only — nothing goes to campaigns, Slack, texts or Follow Up Boss</span>
        ) : (
          <span className="cpv-note">Read-only · private: not visible to clients or the team · {client.name}&apos;s live portal is unchanged</span>
        )}
        {context ? <span className="cpv-note cpv-context">{context}</span> : null}
        <span className="cpv-right">
          {/* The design doesn't say where a client meets its Setup wizard (a first sign-in); the preview opens it from here. */}
          {view === "setup" ? <a href={hrefFor("pipeline")} onClick={(e) => { e.preventDefault(); go("pipeline"); }}>Close the Setup wizard</a> : <a href={`${hrefFor("setup")}&step=1`} onClick={(e) => { e.preventDefault(); setStep(1); setView("setup"); setContext(null); window.history.replaceState(null, "", `${hrefFor("setup")}&step=1`); window.scrollTo(0, 0); }}>Setup wizard</a>}
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

      {view === "setup" ? (
        // The Setup wizard is a page of its own in the design: no sidebar, no chat button.
        <div onClickCapture={onClickCapture}>
          <SetupWizard client={{ id: client.id, name: client.name, contactName: client.contactName, coverage: client.coverage }} team={team} agents={agents} dnc={dnc} step={step} onStep={goStep} onExit={() => go("pipeline")} />
          {toastNote}
        </div>
      ) : (
      /* The handoff's list pages sit in .wrap, which their pop-ups cover; the other screens are the same with or without it. */
      <div className={k("wrap")}>
      <div className={k("app")} data-view={view} onClickCapture={onClickCapture}>
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
                  // The client's own Stripe billing page, in a new tab (19 Oct; api/crm-preview/billing).
                  return (
                    <a key="billing" className={k("ri")} href={`/api/crm-preview/billing?client=${encodeURIComponent(client.id)}`} target="_blank" rel="noopener" title={`Opens ${client.name}'s Stripe billing page — real changes`}>
                      <Icon name={item.icon} size={17} />
                      <span className={k("t")}>{item.label}</span>
                      <span className={k("ex")}><Icon name="external" size={13} /></span>
                    </a>
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
              <i>{initials(client.contactName ?? client.name)}</i>
              <span>
                {client.contactName ?? client.name}
                <small>{client.contactName ? client.name : "Portal preview"}</small>
              </span>
            </div>
          </div>
        </nav>

        <div className={k("main")}>
          {view === "pipeline" ? (
            <PipelineScreen entries={entries} stages={stages} furthest={furthest} team={team} clientId={client.id} now={today} />
          ) : view === "market" || view === "prospects" ? (
            <MarketScreen key={view} clientId={client.id} list={view} onContext={setContext} onOpenMarket={() => go("market")} />
          ) : view === "reports" ? (
            <ReportsScreen clientId={client.id} entries={entries} onContext={setContext} />
          ) : view === "campaigns" ? (
            <CampaignsScreen onChat={() => setChat(true)} />
          ) : view === "help" ? (
            <HelpScreen onChat={() => setChat(true)} />
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
        {/* The design's support chat, on every page: the button opens the chat window (Chat), and closes it. */}
        {chat ? <ChatWindow client={{ id: client.id, contactName: client.contactName }} onClose={() => setChat(false)} /> : null}
        <a
          className={k("aiask")}
          href="#"
          onClick={(e) => { e.preventDefault(); setChat((o) => !o); }}
          aria-label={chat ? "Close support chat" : "Open support chat"}
          title="Support"
          style={{ position: "fixed", right: 24, bottom: 24, zIndex: 13, width: 56, height: 56, borderRadius: 99, background: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 24px rgba(62,107,209,0.35)", textDecoration: "none", color: "#fff" }}
        >
          {chat ? (
            <Icon name="x" size={22} stroke={2} />
          ) : (
            <>
              <Icon name="chat" size={24} stroke={1.9} />
              <span style={{ position: "absolute", top: 2, right: 2, width: 12, height: 12, borderRadius: 99, background: "#22c55e", border: "2px solid #fff" }} />
            </>
          )}
        </a>
        {toastNote}
      </div>
      </div>
      )}
    </DemoContext.Provider>
  );
}
