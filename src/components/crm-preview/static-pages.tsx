"use client";

/*
 * The redesign's two fixed pages, as the design writes them: Campaigns (a
 * "coming soon" page in the design itself) and Help. The help articles,
 * support chat and tour do not exist yet, so their links are drawn disabled.
 */

import { useMemo, useState } from "react";

import { Icon, type IconName } from "./icons";
import { k, RO } from "./k";

const NOT_YET = "Not built yet — part of the redesign, not of this preview";
const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

export function CampaignsScreen({ onChat }: { onChat: () => void }) {
  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}><h1>Campaigns</h1><span className={k("soonp")} style={{ marginLeft: 4 }}>Coming soon</span></div>
        <div className={k("hr")} />
      </header>
      <div className={k("content")}>
        <div className={k("sw2")}>
          <section className={k("card sc")}>
            <span className={k("si")}><Icon name="campaigns" size={26} /></span>
            <span className={k("soonp")}>Coming soon</span>
            <h2>Campaigns are on the way</h2>
            <p>Soon you will be able to edit your email messages and create new campaigns right here. Until then, our team runs your outreach for&nbsp;you.</p>
            <ul className={k("fl2")}>
              <li><span><Icon name="pencil" size={18} /></span><b>Edit your emails</b><small>Update the wording of every email in your sequence yourself.</small></li>
              <li><span><Icon name="plus" size={18} /></span><b>Create campaigns</b><small>Launch a new campaign for a different group of&nbsp;agents.</small></li>
              <li><span><Icon name="mail" size={18} /></span><b>Preview before sending</b><small>See each email exactly as agents will receive&nbsp;it.</small></li>
            </ul>
            <button type="button" className={k("btn")} onClick={onChat}><Icon name="chat" size={15} />Ask support for a change</button>
          </section>
        </div>
      </div>
    </>
  );
}

const TOPICS: Array<{ title: string; icon: IconName; links: string[] }> = [
  { title: "Getting started", icon: "spark", links: ["How BrokerStaffer works", "Your first week", "Setting up your team"] },
  { title: "Your pipeline", icon: "pipeline", links: ["Moving agents between stages", "Replying to an interested agent", "Board and list views"] },
  { title: "My Agents and DNC List", icon: "users", links: ["Adding your own agents", "Blocking a company or domain", "Importing a CSV"] },
  { title: "Team and notifications", icon: "mail", links: ["Adding a teammate", "Who receives interested agents", "Turning a recipient on or off"] },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "How do interested agents reach my team?", a: "We forward every agent who replies interested by email to your active team members. You can see them in your Pipeline too." },
  { q: "How do I make sure we never email my own agents?", a: "Add them to My Agents, one by one or with a CSV import. We never reach out to anyone on that list." },
  { q: "How do I block a sister office?", a: "Add the company to your DNC List with its domain. We block every email at that domain across providers." },
  { q: "Can I change my emails?", a: "Yes. Chat with support and our team will update your emails with you." },
  { q: "How do I add a teammate?", a: "Go to Team and click Add member. Active members receive every agent who replies interested." },
];

export function HelpScreen({ onChat }: { onChat: () => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const topics = useMemo(
    () => TOPICS.map((t) => ({ ...t, links: t.links.filter((l) => !term || l.toLowerCase().includes(term) || t.title.toLowerCase().includes(term)) })).filter((t) => t.links.length),
    [term],
  );
  const faq = useMemo(() => FAQ.filter((f) => !term || `${f.q} ${f.a}`.toLowerCase().includes(term)), [term]);

  return (
    <>
      <header className={k("top")}><div className={k("ttl")}><h1>Help</h1></div><div className={k("hr")} /></header>
      <div className={k("content")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <p className={k("lede")}>Answers to common questions about your recruiting campaign.</p>
          <label className={k("srch")} style={{ width: 420, maxWidth: "100%", height: 38 }}>
            <Icon name="search" size={15} />
            <span style={HIDDEN}>Search help</span>
            <input id="crx-help-search" type="search" placeholder="Search help" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {topics.length ? (
          <div className={k("hgrid")}>
            {topics.map((t) => (
              <section key={t.title} className={k("card topic")} aria-label={t.title}>
                <span className={k("ti")}><Icon name={t.icon} size={16} /></span>
                <h2>{t.title}</h2>
                <ul>{t.links.map((l) => <li key={l}><a href="#" {...RO} title={NOT_YET}>{l}</a></li>)}</ul>
              </section>
            ))}
          </div>
        ) : null}
        <div className={k("hcols")}>
          <section aria-label="Frequently asked questions" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 className={k("sech")}>Frequently asked questions</h2>
            <div className={k("card faq")}>
              {faq.length ? faq.map((f, i) => (
                <details key={f.q} open={i === 0 && !term ? true : term ? true : undefined}>
                  <summary>{f.q}<Icon name="chevDown" size={16} /></summary>
                  <p>{f.a}</p>
                </details>
              )) : <p className="cpv-muted" style={{ padding: "14px 18px", margin: 0 }}>Nothing matches “{q.trim()}”.</p>}
            </div>
          </section>
          <section className={k("card")} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }} aria-label="Contact">
            <h2 className={k("sech")}>Still need help?</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: "#eef2fa", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="chat" size={20} /></span>
              <div>
                <div style={{ fontWeight: 600 }}>Chat with support</div>
                <div className={k("sub")} style={{ fontSize: 12 }}>Get help with your account, campaign or pipeline, any&nbsp;time.</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className={k("btn pri")} style={{ justifyContent: "center" }} onClick={onChat}><Icon name="chat" size={15} />Chat with support</button>
              <button type="button" className={k("btn")} style={{ justifyContent: "center" }} {...RO} title={NOT_YET}><Icon name="spark" size={15} />Take the tour</button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
