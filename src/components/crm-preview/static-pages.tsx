"use client";

/*
 * The redesign's two fixed pages, as the design writes them: Campaigns (a
 * "coming soon" page in the design itself) and Help. The articles are the
 * client's own words (lib/crm-preview/help-articles.ts) on a page drawn in the
 * portal's style, since the handoff stops at their links; the tour is tour.tsx.
 */

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { articleBySlug, articleByTitle, articleText, HELP_ARTICLES, type HelpArticle } from "@/lib/crm-preview/help-articles";

import { Icon, type IconName } from "./icons";
import { k } from "./k";

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
  { title: "Team and notifications", icon: "mail", links: ["Adding a teammate", "Who receives interested agents", "Turning a teammate on or off"] },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "How do interested agents reach my team?", a: "Every agent who replies interested is emailed to the contacts on your account, and shows in your Pipeline too. To see who those contacts are, ask the assistant." },
  { q: "How do I make sure we never email my own agents?", a: "Add them to My Agents, one by one or with a CSV import. We never reach out to anyone on that list." },
  { q: "How do I block a sister office?", a: "Import a CSV to your DNC List with a row for the office: its name, its domain, and company in the kind column. We block every email at that domain across providers." },
  { q: "Can I change my emails?", a: "Yes. Chat with support, ask for a person, and our team will update your emails with you." },
  { q: "How do I add a teammate?", a: "Go to Team and click Add member. To have them receive interested agents too, chat with support and ask for a person." },
];

/** A plain click opens the article here; a new-tab click uses the link's own address. */
const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);

/* "See <another article's title>" in the client's words is a link to it. */
const SEE = new RegExp(`\\b([Ss]ee )(${HELP_ARTICLES.map((a) => a.title).join("|")})\\b`);

function Words({ text, link }: { text: string; link: (a: HelpArticle, label: string) => ReactNode }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={i}>{part.slice(2, -2)}</b>;
        const see = SEE.exec(part);
        if (!see) return <Fragment key={i}>{part}</Fragment>;
        return (
          <Fragment key={i}>
            {part.slice(0, see.index)}{see[1]}{link(articleByTitle(see[2])!, see[2])}{part.slice(see.index + see[0].length)}
          </Fragment>
        );
      })}
    </>
  );
}

function ArticlePage({ article, hrefOf, onArticle, onChat }: { article: HelpArticle; hrefOf: (slug: string | null) => string; onArticle: (slug: string | null) => void; onChat: () => void }) {
  const topic = TOPICS.find((t) => t.links.includes(article.title));
  const link = (a: HelpArticle, label: string) => (
    <a href={hrefOf(a.slug)} onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onArticle(a.slug); } }}>{label}</a>
  );
  const more = (topic?.links ?? []).filter((l) => l !== article.title).map(articleByTitle).filter((a): a is HelpArticle => !!a);
  // A new article is a new page: a keyboard or screen reader starts at its title. It is opened with a key, so this runs per article.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, []);
  return (
    <>
      <header className={k("top")}><div className={k("ttl")}><h1>Help</h1></div><div className={k("hr")} /></header>
      <div className={k("content")}>
        <div className="cpv-art-page">
        <nav className="cpv-art-crumb" aria-label="Breadcrumb">
          <a href={hrefOf(null)} onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onArticle(null); } }}><Icon name="arrowLeft" size={14} />Help</a>
          {topic ? <span>{topic.title}</span> : null}
        </nav>
        <article className={`${k("card")} cpv-art`}>
          <h2 ref={title} tabIndex={-1} className="cpv-art-title">{article.title}</h2>
          {article.blocks.map((b, i) => {
            if ("p" in b) return <p key={i}><Words text={b.p} link={link} /></p>;
            if ("h" in b) return <h3 key={i}>{b.h}</h3>;
            if ("ol" in b) return <ol key={i}>{b.ol.map((t, j) => <li key={j}><Words text={t} link={link} /></li>)}</ol>;
            if ("ul" in b) return <ul key={i}>{b.ul.map((t, j) => <li key={j}><Words text={t} link={link} /></li>)}</ul>;
            return (
              <div key={i} className="cpv-art-table">
                <table>
                  <thead><tr>{b.table.head.map((c, j) => <th key={j} scope="col">{c}</th>)}</tr></thead>
                  <tbody>{b.table.rows.map((r, j) => <tr key={j}>{r.map((c, n) => (n === 0 ? <th key={n} scope="row">{c}</th> : <td key={n}>{c}</td>))}</tr>)}</tbody>
                </table>
              </div>
            );
          })}
        </article>
        {more.length ? (
          <section className="cpv-art-more" aria-label={`More in ${topic?.title}`}>
            <h2>More in {topic?.title}</h2>
            <ul>{more.map((a) => <li key={a.slug}>{link(a, a.title)}</li>)}</ul>
          </section>
        ) : null}
        <section className="cpv-art-ask" aria-label="Contact">
          <span>Still need help?</span>
          <button type="button" className={k("btn")} onClick={onChat}><Icon name="chat" size={15} />Chat with support</button>
        </section>
        </div>
      </div>
    </>
  );
}

export function HelpScreen({ onChat, onTour, article, hrefOf, onArticle }: { onChat: () => void; onTour: () => void; article: string | null; hrefOf: (slug: string | null) => string; onArticle: (slug: string | null) => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // Search looks through the articles' words too: "CSV" finds the ones that explain it, whatever they're called.
  const topics = useMemo(
    () => TOPICS.map((t) => ({
      ...t,
      links: t.links.filter((l) => {
        const a = articleByTitle(l);
        return !term || t.title.toLowerCase().includes(term) || (a ? articleText(a) : l).toLowerCase().includes(term);
      }),
    })).filter((t) => t.links.length),
    [term],
  );
  const faq = useMemo(() => FAQ.filter((f) => !term || `${f.q} ${f.a}`.toLowerCase().includes(term)), [term]);

  const open = articleBySlug(article);
  if (open) return <ArticlePage key={open.slug} article={open} hrefOf={hrefOf} onArticle={onArticle} onChat={onChat} />;

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
                <ul>{t.links.map((l) => {
                  const a = articleByTitle(l)!;
                  return <li key={l}><a href={hrefOf(a.slug)} onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onArticle(a.slug); } }}>{l}</a></li>;
                })}</ul>
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
              <button type="button" className={k("btn")} style={{ justifyContent: "center" }} data-tour-start onClick={onTour}><Icon name="spark" size={15} />Take the tour</button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
