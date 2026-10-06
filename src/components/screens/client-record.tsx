"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Field, StatusPill, type FieldEditor } from "@/components/ds";
import {
  Cell, Id, avatarStyle, fmtDay, fmtNum, initials, intervalLabel, planLabel, tzLabel,
  portalShortName,
  introMissing,
} from "@/components/clients/cells";
import {
  CATEGORIES, CATEGORY_LABEL, FIELD_BY_KEY, TOOL_VIEWS, fieldsIn, shown, type FieldDef, type ToolViewId,
} from "@/lib/clients/field-registry";
import type { MasterClient } from "@/lib/clients/master-list";
import type { CampaignPortalView, CampaignRoute } from "@/lib/clients/campaign-portals";
import type { IntroView } from "@/lib/clients/intro-override";
import { CLIENT_STATUSES, STATUS_MEANING, statusLabel, type ClientStatus } from "@/lib/clients/client-status";
import { TIME_ZONES } from "@/lib/tools/client-health/types";

import { ClientPeople } from "./clients-people";
import { DeleteClient } from "./clients-delete";
import { MarketsPanel } from "./markets-panel";
import type { ChangeKind, ClientPatch } from "./clients";

/*
 * ONE CLIENT.
 *
 * Opened from Clients, it is the whole master record: every §6 field and the
 * §12 dates, each with the system that holds it (§7), edited in place.
 *
 * Opened from a TOOL's Client view (`view`), it is that tool's part of the
 * record and nothing else — the fields §8 lists for the tool, under the
 * tool's own names (§5: "each tool should display the fields relevant to its
 * purpose"). A link opens the full record on Clients.
 *
 * Every save goes through /api/workspace/clients/edit, so the route's rules
 * (Stripe verification, time zones, contacts) apply unchanged and its own
 * words are shown when it refuses. Status asks before it saves (§10).
 */

type Tab = "record" | "campaigns" | "people" | "markets" | "introduce" | "tools";

const TABS: { id: Tab; label: string }[] = [
  { id: "record", label: "Record" },
  { id: "campaigns", label: "Campaigns" },
  { id: "people", label: "Team · Agents · DNC" },
  { id: "markets", label: "Markets" },
  { id: "introduce", label: "Introduce to" },
  { id: "tools", label: "Tools" },
];

const PLAN_OPTIONS = [
  { value: "minimum", label: "Minimum" }, { value: "production", label: "Production" }, { value: "partner", label: "Partner" },
];
const INTERVAL_OPTIONS = ["biweekly", "28-days", "monthly"].map((v) => ({ value: v, label: intervalLabel(v) ?? v }));
const TZ_OPTIONS = TIME_ZONES.map((t) => ({ value: t.value, label: t.label }));

async function saveEdit(id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/workspace/clients/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Could not save (HTTP ${res.status})`);
  // A 200 can carry a leg that failed — say so rather than report success.
  if (body?.failed?.length) throw new Error(`${body.failed[0].what}: ${body.failed[0].error}`);
}

/** Which fields edit in place, how, and which route key they save to. */
function editorFor(key: string, team: { salespeople: string[]; accountManagers: string[] }, members: string[], sellers: string[] | null):
  { editor: FieldEditor; save: string; transform?: (v: string) => unknown } | null {
  switch (key) {
    case "name": return { editor: { kind: "text", maxLength: 80 }, save: "name", transform: (v) => v };
    case "plan": return { editor: { kind: "select", options: PLAN_OPTIONS }, save: "plan", transform: (v) => v };
    case "startDate": return { editor: { kind: "date" }, save: "startDate" };
    case "onboardingDate": return { editor: { kind: "date" }, save: "onboardingDate" };
    case "churnDate": return { editor: { kind: "date" }, save: "churnDate" };
    case "signupDate": return { editor: { kind: "date" }, save: "signupDate" };
    case "website": return { editor: { kind: "text", placeholder: "example.com" }, save: "website" };
    case "zillowUrl": return { editor: { kind: "text", placeholder: "zillow.com/profile/…" }, save: "zillowUrl" };
    case "pocName": return { editor: { kind: "text", maxLength: 120 }, save: "pocName" };
    case "pocEmail": return { editor: { kind: "text", placeholder: "name@company.com" }, save: "pocEmail" };
    case "timezone": return { editor: { kind: "select", options: TZ_OPTIONS }, save: "timezone" };
    case "sender": case "campaignSender": return { editor: { kind: "text" }, save: "sender" };
    // Salesperson: someone on Team access → Salespeople. Before that list
    // exists (sellers === null) it stays the free text it always was.
    case "salesperson": return sellers
      ? { editor: { kind: "select", options: [{ value: "", label: "— No salesperson —" }, ...sellers.map((n) => ({ value: n, label: n }))] }, save: "salesperson" }
      : { editor: { kind: "text", list: team.salespeople }, save: "salesperson" };
    // Account Manager: ONE Team access member with the Account manager role (30 Sep).
    case "accountManager": return {
      editor: { kind: "select", options: [{ value: "", label: "— No account manager —" }, ...members.map((n) => ({ value: n, label: n }))] },
      save: "accountManager",
    };
    case "billingAnchorDate": return { editor: { kind: "date" }, save: "billingAnchorDate" };
    case "billingInterval": return { editor: { kind: "select", options: INTERVAL_OPTIONS }, save: "billingInterval", transform: (v) => v };
    case "stripeSubscriptionId": return { editor: { kind: "text", placeholder: "sub_…" }, save: "stripeSubscriptionId" };
    case "stripeCustomerId": return { editor: { kind: "text", placeholder: "cus_…" }, save: "stripeCustomerId" };
    case "campaignAliases": return {
      editor: { kind: "text", placeholder: "Comma-separated, e.g. Keyes, The Keyes Co" }, save: "aliases",
      transform: (v) => v.split(",").map((s) => s.trim()).filter(Boolean),
    };
    case "monthlyTarget": return { editor: { kind: "number", min: 0 }, save: "monthlyTarget", transform: (v) => Number(v || 0) };
    default: return null;
  }
}

/** The raw value an editor starts from. */
function rawOf(key: string, c: MasterClient): string | number | null {
  if (key === "campaignAliases") return c.campaignAliases.join(", ");
  if (key === "campaignSender") return c.sender;
  // A derived date can be a timestamp; the date editor wants YYYY-MM-DD.
  if (key === "onboardingDate" || key === "churnDate") return c[key] ? c[key]!.slice(0, 10) : null;
  // The editor starts from what is shown: the entered day, else Stripe's.
  if (key === "signupDate") return (c.signupDate ?? c.stripe?.signupDate ?? null)?.slice(0, 10) ?? null;
  const v = (c as unknown as Record<string, unknown>)[key];
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/** How an editable field reads when not being edited. */
function displayFor(key: string, c: MasterClient): React.ReactNode {
  switch (key) {
    case "plan": return planLabel(c.plan);
    case "timezone": return tzLabel(c.timezone);
    case "startDate": case "billingAnchorDate": case "onboardingDate": case "churnDate": return fmtDay(c[key]);
    case "billingInterval": return intervalLabel(c.billingInterval, c.billingIntervalDays);
    case "campaignAliases": return c.campaignAliases.length ? c.campaignAliases.join(", ") : null;
    case "monthlyTarget": return c.monthlyTarget === null ? null : `${c.monthlyTarget} per 28 days`;
    // Empty reads "Not set", like every other editable field.
    case "signupDate": return c.signupDate || c.stripe?.signupDate ? <Cell k={key} c={c} /> : null;
    case "website": case "zillowUrl": case "pocEmail": return c[key] ? <Cell k={key} c={c} /> : null;
    default: return undefined;
  }
}

/** Where a field that is edited elsewhere is managed, inside this panel. */
const MANAGED_IN: Record<string, Tab> = {
  market: "markets", mls: "markets", area: "markets",
  team: "people", agents: "people", dnc: "people",
  campaignId: "campaigns", campaignName: "campaigns", campaignStatus: "campaigns",
};

export function ClientRecord({
  client: c, view, onClose, onChanged, onPatch, onDeleted, onPrev, onNext, position,
}: {
  client: MasterClient;
  /** Opened from a tool's Client view: show only that tool's §8 fields. */
  view?: ToolViewId;
  onClose: () => void;
  /** Refresh the list; "stripe" when a Stripe id changed, so Stripe's figures are read again. */
  onChanged: (kind?: ChangeKind) => void;
  /**
   * Show a saved change at once (6 Oct). Without it the field closed showing
   * the OLD value for the 12–15s the list took to rebuild.
   */
  onPatch?: (patch: ClientPatch) => void;
  onDeleted: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** "12 / 50" — where this client sits in the list it was opened from. */
  position?: string;
}) {
  const [tab, setTab] = useState<Tab>("record");
  const [team, setTeam] = useState<{ salespeople: string[]; accountManagers: string[] }>({ salespeople: [], accountManagers: [] });
  // Account Manager = a Team access member (30 Sep): the dropdown offers exactly that list.
  const [members, setMembers] = useState<string[]>([]);
  // Salesperson = someone on Team access → Salespeople; null until that list is known to exist.
  const [sellers, setSellers] = useState<string[] | null>(null);
  const tool = view ? TOOL_VIEWS.find((t) => t.id === view) ?? null : null;

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/clients/team", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (live && t) setTeam({ salespeople: t.salespeople ?? [], accountManagers: t.accountManagers ?? [] }); })
      .catch(() => {});
    fetch("/api/workspace/salespeople", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (live && t?.available) setSellers((t.people as { name: string }[]).map((p) => p.name)); })
      .catch(() => {});
    fetch("/api/workspace/team-members", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => { if (live && t?.members) setMembers((t.members as { name: string }[]).map((m) => m.name)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // Escape closes; ↑ / ↓ (or k / j) move through the list — never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (typing) return;
      if (e.key === "Escape") onClose();
      if ((e.key === "ArrowUp" || e.key === "k") && onPrev) { e.preventDefault(); onPrev(); }
      if ((e.key === "ArrowDown" || e.key === "j") && onNext) { e.preventDefault(); onNext(); }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose, onPrev, onNext]);

  /** Save one field, show it at once, then refresh. `regKey` is the field's own key (what the list reads). */
  const save = (key: string, transform: (v: string) => unknown = (v) => v || null, regKey: string = key) => async (v: string) => {
    const value = transform(v);
    await saveEdit(c.id, { [key]: value });
    onPatch?.(patchFor(regKey, value));
    onChanged(regKey.startsWith("stripe") ? "stripe" : undefined);
  };

  /** One field row: an in-place editor where the master record owns it, the value otherwise. */
  const row = (key: string, label: string, def?: FieldDef) => {
    const ed = editorFor(key, team, members, sellers);
    const source = def?.source;
    if (ed) {
      return (
        <div key={key} className="rx-row" title={def?.definition}>
          <Field label={label} source={source} value={rawOf(key, c)} display={displayFor(key, c)}
            editor={ed.editor} onSave={save(ed.save, ed.transform, key)} />
        </div>
      );
    }
    const managed = !tool ? MANAGED_IN[key] : undefined;
    return (
      <div key={key} className="rx-row" title={def?.definition}>
        <div className="ds-field">
          <div className="ds-field-l"><span>{label}</span>{source ? <em className="ds-field-src">{source}</em> : null}</div>
          <div className="ds-field-v">
            <div className="rx-static">
              <Cell k={key} c={c} />
              {managed ? (
                <button type="button" className="rx-go" onClick={() => setTab(managed)}>{managed === "campaigns" ? "View" : "Manage"} →</button>
              ) : def && !tool ? <small className="rx-why">{def.editIn}</small> : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const period = c.health.period;
  const daysToBilling = c.nextBillingDate
    ? Math.round((Date.parse(`${c.nextBillingDate}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000)
    : null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="rx-scrim" onClick={onClose} />
      <aside className="rx" role="dialog" aria-modal="true" aria-label={`${c.name} — ${tool ? `${tool.label} view` : "client record"}`}>
        {/* ------------------------------------------------------- header */}
        <header className="rx-head">
          <div className="rx-bar">
            <span className="rx-kicker">{tool ? `${tool.label} · client view` : "Master client record"}</span>
            <span className="rx-nav">
              {position ? <span className="rx-pos">{position}</span> : null}
              <button type="button" className="rx-icon" onClick={onPrev} disabled={!onPrev} aria-label="Previous client" title="Previous client (↑)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
              </button>
              <button type="button" className="rx-icon" onClick={onNext} disabled={!onNext} aria-label="Next client" title="Next client (↓)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <button type="button" className="rx-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </span>
          </div>
          <div className="rx-id">
            <span className="cx-av lg" style={avatarStyle(c.name)} aria-hidden="true">{initials(c.name)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2>{c.name}</h2>
              <div className="rx-tags">
                <StatusPill status={c.status} size="sm" />
                {c.plan ? <span className="rx-tag">{planLabel(c.plan)}</span> : null}
                {c.statusSince ? <span className="rx-meta">since {fmtDay(c.statusSince)}</span> : null}
                <span className="rx-meta">ID <Id value={c.id} /></span>
              </div>
            </div>
            <div className="rx-actions">
              {(c.portal.links?.length ?? 0) > 1
                ? c.portal.links.filter((l) => l.enabled).map((l) => (
                    <a key={l.url} className="rx-btn" href={l.url} target="_blank" rel="noreferrer" title={l.name}>{portalShortName(l.name, c.portal.links)} ↗</a>
                  ))
                : c.portal.url ? <a className="rx-btn" href={c.portal.url} target="_blank" rel="noreferrer">Portal ↗</a> : null}
              {tool ? <a className="rx-btn" href={`/roster?client=${c.id}`}>Full record →</a> : <DeleteClient id={c.id} name={c.name} onDeleted={onDeleted} />}
            </div>
          </div>
        </header>

        {tool ? (
          /* ------------------------------- a tool's part of the record, only */
          <div className="rx-body" key={c.id}>
            <section className="rx-sec">
              <h3>{tool.label}<span>the fields §8 lists for this tool</span></h3>
              {tool.columns.filter((col) => col.key !== "name" && shown(col.key)).map((col) => row(col.key, col.label, FIELD_BY_KEY[col.key]))}
            </section>
            {view === "portal" ? (
              <section className="rx-sec">
                <h3>Team · Agents · DNC<span>shared with the client&rsquo;s portal</span></h3>
                <ClientPeople clientId={c.id} onChanged={() => onChanged()} />
              </section>
            ) : null}
            {view === "database" ? <Campaigns c={c} /> : null}
            <p className="rx-hint">Read from the master client record. A change made here is made once, for every tool — the <a href={`/roster?client=${c.id}`}>full record</a> is on Clients.</p>
          </div>
        ) : (
          <>
            {/* ------------------------------------------------ at a glance */}
            <div className="rx-kpis">
              <div>
                <small>Introductions</small>
                <b>{fmtNum(c.introductions) ?? "—"}</b>
                <span>{c.lastIntroAt ? `last ${fmtDay(c.lastIntroAt)}` : "none yet"}</span>
              </div>
              <div>
                <small>28-day period</small>
                <b>{period ? <>{period.delivered}<i>/{period.target}</i></> : "—"}</b>
                <span className={`pace-${c.health.pace ?? "none"}`}>{c.health.pace === "done" ? "target met" : c.health.pace === "ok" ? "on pace" : c.health.pace === "risk" ? "behind pace" : "no target"}</span>
              </div>
              <div>
                <small>Next billing</small>
                <b>{c.nextBillingDate ? fmtDay(c.nextBillingDate)?.replace(/, \d{4}$/, "") : "—"}</b>
                <span>{daysToBilling === null ? "no schedule" : daysToBilling === 0 ? "today" : `in ${daysToBilling} day${daysToBilling === 1 ? "" : "s"}`}</span>
              </div>
              <div>
                <small>Agents</small>
                <b>{fmtNum(c.agents) ?? "—"}</b>
                <span>{c.team !== null ? `${c.team} team · ${fmtNum(c.dnc)} DNC` : "—"}</span>
              </div>
            </div>

            {introMissing(c).length ? (
              <div className="rx-hint" role="status" style={{ margin: "12px 24px 0", padding: "8px 12px", borderRadius: 8, background: "#FFF4E5", color: "#8A4B0F", border: "1px solid #F8D9C2", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <b>No intro template.</b>
                <span>The Introduce button cannot be used for {c.name} until its {introMissing(c).join(" and ")} {introMissing(c).length > 1 ? "are" : "is"} added.</span>
                {!tool ? <button type="button" className="rx-btn" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setTab("introduce")}>Add them</button> : null}
              </div>
            ) : null}
            <nav className="rx-tabs" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.id} type="button" className={tab === t.id ? "on" : ""} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.id === "campaigns" && c.campaigns ? <span className="n">{c.campaigns.length}</span> : null}
                  {t.id === "markets" && c.markets?.markets != null ? <span className="n">{c.markets.markets}</span> : null}
                </button>
              ))}
            </nav>

            {/* Keyed by client: every draft, pending confirmation and in-flight
                read below belongs to ONE client. Without the key, moving to the
                next client kept a "Change to Churned?" or "Pause billing?" box
                (or a half-edited field) on screen, and confirming it acted on
                the client now showing. The tab above is deliberately kept. */}
            <div className="rx-body" key={c.id}>
              {tab === "record" ? (
                <>
                  <section className="rx-sec">
                    <h3>Status<span>changes every tool, the portal, campaigns and billing</span></h3>
                    <StatusField id={c.id} status={c.status} onChanged={onChanged} onPatch={onPatch} />
                  </section>
                  {CATEGORIES.map((cat) => (
                    <section key={cat} className={`rx-sec cat-${cat}`}>
                      <h3><i aria-hidden="true" />{CATEGORY_LABEL[cat]}</h3>
                      {cat === "billing" ? <BillingControl clientId={c.id} onChanged={() => onChanged("stripe")} /> : null}
                      {fieldsIn(cat).filter((f) => f.key !== "status").map((f) => row(f.key, f.label, f))}
                    </section>
                  ))}
                </>
              ) : null}
              {tab === "campaigns" ? <Campaigns c={c} onChanged={() => onChanged()} /> : null}
              {tab === "people" ? (
                <section className="rx-sec">
                  <h3>Team · Agents · DNC<span>held by Master Inbox · shared with the portal</span></h3>
                  <ClientPeople clientId={c.id} onChanged={() => onChanged()} />
                </section>
              ) : null}
              {tab === "markets" ? (
                <section className="rx-sec">
                  <h3>Market · MLS · Area<span>a client may cover several</span></h3>
                  <MarketsPanel clientId={c.id} onChanged={() => onChanged()} />
                </section>
              ) : null}
              {tab === "introduce" ? (
                <>
                <section className="rx-sec">
                  <h3>The introduction<span>what the Introduce button and the reply agent send</span></h3>
                  <IntroPreview clientId={c.id} refreshKey={JSON.stringify(c.contact)} onChanged={onChanged} />
                </section>
                <section className="rx-sec">
                  <h3>Introduce to<span>used by the Introduce button in Master Inbox</span></h3>
                  <div className="rx-row">
                    <Field label="Brokerage" source="Master record" value={c.contact.brokerage}
                      editor={{ kind: "text" }} onSave={async (v) => { await save("brokerage")(v); onPatch?.({ contact: { brokerage: v || null } }); }} />
                  </div>
                  {[0, 1, 2].map((i) => {
                    const v = i === 0 ? { name: c.contact.name, role: c.contact.role, email: c.contact.email, territories: c.contact.territories ?? [] } : c.contact.extra[i - 1] ?? { name: null, role: null, email: null };
                    const p = i === 0 ? "contact" : `contact${i + 1}`;
                    return (
                      <div key={i} className="rx-row">
                        <ContactEditor ordinal={i} value={v}
                          onSave={async (d) => {
                            const patch: Record<string, unknown> = { [`${p}Name`]: d.name, [`${p}Role`]: d.role, [`${p}Email`]: d.email };
                            // Sent only when changed, so saving a name never touches territories.
                            if ((d.territories ?? []).join("|") !== (v.territories ?? []).join("|")) patch[`${p}Territories`] = d.territories ?? [];
                            await saveEdit(c.id, patch);
                            const person = { name: d.name, role: d.role, email: d.email, territories: d.territories ?? v.territories ?? [] };
                            onPatch?.({ contact: i === 0
                              ? { name: person.name, role: person.role, email: person.email, territories: person.territories }
                              : { extra: c.contact.extra.map((x, j) => (j === i - 1 ? person : x)) } });
                            onChanged();
                          }} />
                      </div>
                    );
                  })}
                  <MorePeople clientId={c.id} contact={c.contact} onChanged={onChanged} onPatch={onPatch} />
                </section>
                </>
              ) : null}
              {tab === "tools" ? <Tools c={c} /> : null}
            </div>
          </>
        )}
      </aside>
    </>,
    document.body,
  );
}

/* ---------------------------------------------------------------- campaigns --- */
function Campaigns({ c, onChanged }: { c: MasterClient; onChanged?: () => void }) {
  const routing = useCampaignPortals(c.id);
  const multi = routing.view?.multi ?? false;
  const routeOf = (x: NonNullable<MasterClient["campaigns"]>[number]) =>
    routing.view?.campaigns.find((r) => r.name === x.name && r.platform === (x.platform === "Instantly" ? "instantly" : "emailbison"));
  return (
    <section className="rx-sec">
      <h3>Campaigns<span>read from Instantly and EmailBison</span></h3>
      {routing.view && (multi || routing.view.canAddPortal) ? (
        <PortalsLine view={routing.view} addPortal={routing.view.canAddPortal ? <AddPortal clientId={c.id} onAdded={(v) => { routing.replace(v); onChanged?.(); }} /> : null} />
      ) : null}
      {multi && routing.view && !routing.view.ready ? (
        <p className="rx-hint">Choosing a portal per campaign needs migration 0025 run in the Master Inbox Supabase project.</p>
      ) : null}
      {routing.error ? <p className="rx-hint" style={{ color: "var(--x-bad, #b42318)" }}>{routing.error}</p> : null}
      {!c.campaigns ? <p className="rx-hint">Campaigns could not be read.</p>
        : !c.campaigns.length ? <p className="rx-hint">No campaign is linked to {c.name} yet.</p>
        : (
          <div className="rx-camps">
            {c.campaigns.map((x) => {
              const r = multi ? routeOf(x) : undefined;
              return (
                <div key={`${x.platform}:${x.id}`} className="rx-camp" style={multi ? { gridTemplateColumns: "auto 1fr auto auto" } : undefined}>
                  <span className={`rx-plat ${x.platform === "Instantly" ? "i" : "b"}`}>{x.platform === "Instantly" ? "IN" : "EB"}</span>
                  <div style={{ minWidth: 0 }}>
                    <b title={x.name}>{x.name}</b>
                    <small><Id value={x.id} />{x.leads !== null ? <span>{fmtNum(x.leads)} leads</span> : null}</small>
                  </div>
                  <span className={`rx-cs s-${(x.status ?? "unknown").toLowerCase()}`}><i />{x.status ? x.status.charAt(0).toUpperCase() + x.status.slice(1) : "Unknown"}</span>
                  {multi && routing.view ? <PortalPicker route={r} view={routing.view} saving={routing.saving} onPick={routing.pick} /> : null}
                </div>
              );
            })}
          </div>
        )}
      {multi ? <p className="rx-hint">Each campaign&apos;s portal is chosen automatically once, from the market in its name, and can be changed here. Only new replies follow a change — leads already in a portal stay there.</p> : null}
    </section>
  );
}

/* Which portal each campaign feeds — only for a client with several portals (0025). */
function useCampaignPortals(clientId: string) {
  const [view, setView] = useState<CampaignPortalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/workspace/clients/campaign-portals?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (live) setView(body as CampaignPortalView);
      })
      .catch((e) => { if (live) setError(`Portals could not be read: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { live = false; };
  }, [clientId]);
  async function pick(route: CampaignRoute, portalId: string) {
    if (!route.campaignId) return;
    const key = `${route.platform}:${route.campaignId}`;
    setSaving(key); setError(null);
    try {
      const res = await fetch("/api/workspace/clients/campaign-portals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, platform: route.platform, campaignId: route.campaignId, portalId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setView(body.view as CampaignPortalView);
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(null);
    }
  }
  // After Add portal: the new view, keeping who-may-add from the first read.
  const replace = (v: CampaignPortalView) => setView((old) => ({ ...v, canAddPortal: old?.canAddPortal }));
  return { view, error, saving, pick, replace };
}

function portalLabel(view: CampaignPortalView, id: string | null | undefined): string {
  const p = view.portals.find((x) => x.id === id);
  if (!p) return "—";
  // "Properties & Estates Florida" → "Florida": the market is what tells them apart.
  const names = view.portals.map((x) => x.name.split(/\s+/));
  let common = 0;
  while (names.every((n) => n.length > common && n[common] === names[0][common])) common++;
  const short = p.name.split(/\s+/).slice(common).join(" ");
  return short || p.name;
}

function PortalsLine({ view, addPortal }: { view: CampaignPortalView; addPortal: React.ReactNode }) {
  const n = view.portals.length;
  return (
    <div className="rx-hint" style={{ marginTop: 0 }}>
      {n === 0 ? "No portal yet." : n === 1 ? "Leads go to its portal: " : `Leads go to one of ${n} portals: `}
      {view.portals.map((p, i) => (
        <span key={p.id}>
          {i ? " · " : ""}
          {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{n === 1 ? p.name : portalLabel(view, p.id)}</a> : n === 1 ? p.name : portalLabel(view, p.id)}
          {n > 1 && p.main ? " (main)" : ""}{!p.enabled ? " (switched off)" : ""}
        </span>
      ))}
      {addPortal}
    </div>
  );
}

/* Admins: give the client another portal, for a new market. */
function AddPortal({ clientId, onAdded }: { clientId: string; onAdded: (v: CampaignPortalView) => void }) {
  const [open, setOpen] = useState(false);
  const [market, setMarket] = useState("");
  const [preview, setPreview] = useState<{ name: string; moves: string[]; keptManual: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean; url?: string | null } | null>(null);
  const reset = () => { setOpen(false); setMarket(""); setPreview(null); };

  async function check() {
    setBusy(true); setMsg(null); setPreview(null);
    try {
      const res = await fetch(`/api/workspace/clients/portals?clientId=${encodeURIComponent(clientId)}&market=${encodeURIComponent(market)}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setPreview(body);
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), bad: true }); } finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/workspace/clients/portals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, market }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      onAdded(body.view as CampaignPortalView);
      setMsg({
        text: `Created ${body.portal.name}. ${body.relinked ? `${body.relinked} campaign${body.relinked === 1 ? "" : "s"} now send new leads to it.` : "No campaign mentions this market yet — choose its portal on a campaign below, or new campaigns naming it will go there."}${body.note ? ` ${body.note}` : ""}`,
        url: body.portal.url,
      });
      reset();
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), bad: true }); } finally { setBusy(false); }
  }

  return (
    <>
      {" · "}
      {!open ? <button type="button" className="rx-btn" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => { setOpen(true); setMsg(null); }}>+ Add portal</button> : null}
      {open ? (
        <div className="rx-confirm" style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>Market</span>
            <input className="ds-input" style={{ width: 200 }} placeholder="e.g. Orlando" value={market} maxLength={40}
              onChange={(e) => { setMarket(e.target.value); setPreview(null); }} disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter" && market.trim()) void check(); }} />
            {!preview ? <button type="button" className="rx-btn solid" disabled={busy || !market.trim()} onClick={() => void check()}>{busy ? "Checking…" : "Continue"}</button> : null}
            <button type="button" className="rx-btn" disabled={busy} onClick={reset}>Cancel</button>
          </label>
          {preview ? (
            <div style={{ display: "grid", gap: 6 }}>
              <span>Creates the portal <b>{preview.name}</b> with its own link, set up like every other portal (its team, agents and DNC list start empty).</span>
              <span>
                {preview.moves.length
                  ? <>New leads from these campaigns will go to it: {preview.moves.join(" · ")}.</>
                  : "No campaign mentions this market yet; new campaigns that do will go to it automatically."}
                {preview.keptManual.length ? <> Kept where a person chose: {preview.keptManual.join(" · ")}.</> : null}
                {" "}Leads already in a portal stay where they are.
              </span>
              <div><button type="button" className="rx-btn solid" disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Create portal"}</button></div>
            </div>
          ) : null}
        </div>
      ) : null}
      {msg ? (
        <div style={{ marginTop: 8, color: msg.bad ? "var(--x-bad, #b42318)" : undefined }}>
          {msg.text}{msg.url ? <> <a href={msg.url} target="_blank" rel="noreferrer">Open the new portal ↗</a></> : null}
        </div>
      ) : null}
    </>
  );
}

function PortalPicker({ route, view, saving, onPick }: {
  route: CampaignRoute | undefined; view: CampaignPortalView; saving: string | null;
  onPick: (r: CampaignRoute, portalId: string) => void;
}) {
  if (!route) return <span className="rx-cs">—</span>;
  const current = route.portalId ?? route.suggestion?.portalId ?? "";
  const busy = saving === `${route.platform}:${route.campaignId}`;
  const note = !route.campaignId ? "no campaign number yet"
    : route.source === "manual" ? `chosen${route.decidedBy ? ` by ${route.decidedBy.split("@")[0]}` : ""}`
    : route.source === "auto" ? "chosen automatically"
    : "will be chosen automatically";
  return (
    <label style={{ display: "grid", gap: 2, justifyItems: "end" }} title={route.suggestion?.reason ? `Automatic choice: ${route.suggestion.reason}` : undefined}>
      <select className="ds-input" style={{ minWidth: 0, width: 150, padding: "4px 6px", fontSize: 12.5 }}
        aria-label={`Portal for ${route.name}`} value={current}
        disabled={!view.ready || !route.campaignId || busy}
        onChange={(e) => onPick(route, e.target.value)}>
        {!current ? <option value="">Choose…</option> : null}
        {view.portals.map((p) => <option key={p.id} value={p.id}>{portalLabel(view, p.id)}</option>)}
      </select>
      <small style={{ fontSize: 11, color: "var(--x-mute)" }}>{busy ? "saving…" : note}</small>
    </label>
  );
}

/* -------------------------------------------------------------------- tools --- */
function Tools({ c }: { c: MasterClient }) {
  const rows: { tool: string; present: boolean | null; note: string }[] = [
    { tool: "Master Inbox", present: c.portal.count > 0, note: c.portal.count ? `${c.portal.count} portal${c.portal.count === 1 ? "" : "s"} · ${fmtNum(c.introductions) ?? 0} introductions` : "no inbox client" },
    { tool: "Client Portal", present: c.portal.url ? true : c.portal.count ? false : null, note: c.portal.url ? "open" : c.portal.count ? "closed" : "none" },
    { tool: "Client Health", present: c.health.present, note: c.health.present ? `${planLabel(c.plan) ?? "no plan"} · ${c.monthlyTarget ?? 0} / 28 days` : "not in Client Health" },
    { tool: "Database", present: c.database.present, note: c.database.present ? `${fmtNum(c.assignedLeads) ?? 0} leads · ${fmtNum(c.replies) ?? 0} replies` : "not in the Database" },
    { tool: "Onboarding", present: c.onboarding.present, note: c.onboarding.progress ? `${c.onboarding.progress.done}/${c.onboarding.progress.total} steps` : "—" },
    { tool: "Analytics", present: c.analytics.present, note: c.analytics.present ? `${fmtNum(c.analytics.campaigns) ?? 0} campaigns · ${fmtNum(c.analytics.sent) ?? 0} sent` : "not in Analytics" },
  ];
  return (
    <section className="rx-sec">
      <h3>Where this client exists<span>§16 — a missing tool is a sync problem unless it is a recorded exception</span></h3>
      <div className="rx-tools">
        {rows.map((r) => (
          <div key={r.tool} className="rx-tool">
            <span className={`rx-tool-dot ${r.present ? "ok" : r.present === false ? "bad" : "na"}`} aria-hidden="true" />
            <b>{r.tool}</b>
            <small>{r.note}</small>
          </div>
        ))}
      </div>
      <p className="rx-hint">Sync status for every client — counts, missing records, conflicts — is on <a href="/consistency">Consistency</a>.</p>
    </section>
  );
}

/*
 * Status, with a confirmation. Pausing or churning closes the portal and
 * pauses campaigns and Stripe billing; reactivating resumes billing and
 * reopens the portal (campaigns stay paused — restarting them is a person's
 * decision).
 */
function StatusField({ id, status, onChanged, onPatch }: { id: string; status: ClientStatus; onChanged: () => void; onPatch?: (p: ClientPatch) => void }) {
  const [pending, setPending] = useState<ClientStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effect = (s: ClientStatus): string =>
    s === "paused" || s === "churned"
      ? "The portal closes, and the client's running campaigns and Stripe billing are paused."
      : s === "active"
        ? "The portal reopens and Stripe billing resumes. Paused campaigns stay paused — restart them deliberately."
        : "Recorded in every tool. The portal is left as it is.";

  async function confirm() {
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/clients/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: pending }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setPending(null);
      onPatch?.({ status: pending });
      onChanged();
      // The status is saved; a tool that did not take it must still be named.
      const failed = ((body?.propagation?.legs ?? []) as { label: string; ok: boolean; error?: string }[]).filter((l) => !l.ok);
      if (failed.length) {
        setError(`Saved, but not everywhere: ${failed.map((l) => `${l.label}${l.error ? ` (${l.error})` : ""}`).join("; ")}. Try the change again, or see Consistency.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="rx-status" role="group" aria-label="Client status">
        {CLIENT_STATUSES.map((s) => (
          <button key={s} type="button" className={`st-${s}`} aria-pressed={(pending ?? status) === s} disabled={saving}
            title={STATUS_MEANING[s]} onClick={() => { setError(null); setPending(s === status ? null : s); }}>
            <span className="st-dot" aria-hidden="true" />{statusLabel(s)}
          </button>
        ))}
      </div>
      {pending ? (
        <div className="rx-confirm" role="alert">
          <span><b>Change to {statusLabel(pending)}?</b> {effect(pending)}</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button type="button" className="rx-btn solid" disabled={saving} onClick={() => void confirm()}>
              {saving ? "Changing…" : `Change to ${statusLabel(pending)}`}
            </button>
            <button type="button" className="rx-btn" disabled={saving} onClick={() => setPending(null)}>Cancel</button>
          </span>
        </div>
      ) : null}
      {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
    </div>
  );
}

/*
 * Pause / resume Stripe billing by hand (30 Sep). Admins only: the route
 * refuses everyone else, and for them this renders nothing. Reads Stripe live,
 * so what it shows is what Stripe is doing now — including a pause somebody
 * set in the Stripe dashboard. Pausing never cancels.
 */
interface BillingNow { status: string; paused: boolean; behavior: string | null; amount: number | null; every: string | null; nextBilling: string | null }
interface OpenLink { id: string; url: string; label: string; createdAt: string }

function BillingControl({ clientId, onChanged }: { clientId: string; onChanged?: () => void }) {
  const [state, setState] = useState<{ hidden?: true; linked?: boolean; billing?: BillingNow; links?: OpenLink[] | null; canCreateLinks?: boolean; error?: string } | null>(null);
  const [pending, setPending] = useState<"pause" | "resume" | null>(null);
  const [creating, setCreating] = useState(false);
  const [amount, setAmount] = useState("");
  const [every, setEvery] = useState<"14 days" | "28 days" | "month">("14 days");
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/workspace/clients/billing?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" });
      if (res.status === 403 || res.status === 401) { setState({ hidden: true }); return; }
      const body = await res.json().catch(() => null);
      setState(body ?? { error: `HTTP ${res.status}` });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : "Stripe could not be read" });
    }
  };
  useEffect(() => { void load(); }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state || state.hidden) return null;
  const b = state.billing;
  const money = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  const cancelled = b && (b.status === "canceled" || b.status === "incomplete_expired");
  const links = state.links ?? [];
  // A new subscription: none linked, or the linked one has ended — and no link already waiting.
  const mayCreate = state.canCreateLinks && (state.linked === false || cancelled) && links.length === 0;

  async function post(body: Record<string, unknown>) {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/workspace/clients/billing", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, ...body }),
      });
      const out = await res.json().catch(() => null);
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function confirmPause() {
    if (!pending) return;
    const out = await post({ action: pending });
    if (out) { setPending(null); setState((s) => ({ ...s, linked: true, billing: out.billing })); onChanged?.(); }
  }
  async function createLink() {
    const out = await post({ action: "create_link", amount, every });
    if (out) { setCreating(false); setConfirmCreate(false); setAmount(""); await load(); }
  }
  async function cancelLink(id: string) {
    const out = await post({ action: "cancel_link", linkId: id });
    await load();
    if (out) setCopied(null);
  }
  const copy = async (url: string, id: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(id); } catch { setCopied(null); }
  };
  const everyLabel = every === "month" ? "every month" : `every ${every}`;

  return (
    <div className="rx-row">
      <div className="ds-field">
        <div className="ds-field-l"><span>Stripe billing</span><em className="ds-field-src">Stripe · admins only</em></div>
        <div className="ds-field-v" style={{ display: "grid", gap: 8 }}>
          {state.error && !b ? <span className="ds-field-err">{state.error}</span> : null}
          {state.linked === false && !links.length ? <span className="cx-none">No Stripe subscription yet</span> : null}
          {b ? (
            <div className="rx-static">
              <span>
                <b style={{ color: cancelled ? "var(--x-mute)" : b.paused ? "var(--st-paused)" : "var(--st-active)" }}>
                  {cancelled ? `Subscription ${b.status}` : b.paused ? "Paused" : "Collecting"}
                </b>
                {" · "}{money(b.amount)}{b.every ? ` every ${b.every}` : ""}
                {!cancelled && !b.paused && b.nextBilling ? ` · next charge ${fmtDay(b.nextBilling)}` : ""}
                {b.paused && b.behavior === "keep_as_draft" ? " · invoices held as drafts" : b.paused && b.behavior === "void" ? " · invoices voided while paused" : ""}
              </span>
              {!cancelled ? (
                <button type="button" className="rx-btn" disabled={saving || pending !== null}
                  onClick={() => { setError(null); setPending(b.paused ? "resume" : "pause"); }}>
                  {b.paused ? "Resume billing" : "Pause billing"}
                </button>
              ) : null}
            </div>
          ) : null}
          {pending ? (
            <div className="rx-confirm" role="alert">
              <span>
                <b>{pending === "pause" ? "Pause billing?" : "Resume billing?"}</b>{" "}
                {pending === "pause"
                  ? "Stripe stops charging this client and voids invoices while paused. The subscription is kept, never cancelled, and can be resumed. The client's status does not change."
                  : "Stripe starts charging this client again from the next billing date. The client's status does not change."}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="rx-btn solid" disabled={saving} onClick={() => void confirmPause()}>
                  {saving ? "Saving…" : pending === "pause" ? "Pause billing" : "Resume billing"}
                </button>
                <button type="button" className="rx-btn" disabled={saving} onClick={() => setPending(null)}>Cancel</button>
              </span>
            </div>
          ) : null}

          {/* Payment links waiting to be paid — copy and send; the subscription links itself once paid. */}
          {links.map((l) => (
            <div key={l.id} className="rx-confirm">
              <span><b>Payment link — {l.label}</b> · waiting for the client to pay. Once paid, the subscription is linked to this client automatically.</span>
              <input className="ds-input" readOnly value={l.url} aria-label="Payment link" onFocus={(e) => e.currentTarget.select()} />
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="rx-btn solid" onClick={() => void copy(l.url, l.id)}>{copied === l.id ? "Copied" : "Copy link"}</button>
                <a className="rx-btn" href={l.url} target="_blank" rel="noreferrer">Open ↗</a>
                <button type="button" className="rx-btn" disabled={saving} onClick={() => void load()}>Check payment</button>
                <button type="button" className="rx-btn" disabled={saving} onClick={() => void cancelLink(l.id)}>Cancel link</button>
              </span>
            </div>
          ))}

          {mayCreate && !creating ? (
            <div><button type="button" className="rx-btn" onClick={() => { setError(null); setCreating(true); }}>Create subscription</button></div>
          ) : null}
          {creating ? (
            <div className="rx-confirm">
              <span><b>Create a subscription</b> — the OS makes a Stripe payment link for this amount. Send it to the client; the subscription starts when they pay.</span>
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input className="ds-input" style={{ width: 140 }} inputMode="decimal" placeholder="Amount, e.g. 750" aria-label="Amount in dollars"
                  value={amount} disabled={confirmCreate || saving} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,$]/g, ""))} />
                <select className="ds-input" style={{ width: 170 }} aria-label="How often" value={every} disabled={confirmCreate || saving}
                  onChange={(e) => setEvery(e.target.value as typeof every)}>
                  <option value="14 days">Every 14 days</option>
                  <option value="28 days">Every 28 days</option>
                  <option value="month">Every month</option>
                </select>
              </span>
              {confirmCreate ? (
                <span>
                  Create a Stripe payment link for <b>${amount.replace(/[$,]/g, "")} {everyLabel}</b>? Nothing is charged until the client pays through it, and it can only be paid once.
                </span>
              ) : null}
              <span style={{ display: "flex", gap: 8 }}>
                {confirmCreate ? (
                  <button type="button" className="rx-btn solid" disabled={saving} onClick={() => void createLink()}>{saving ? "Creating…" : "Create payment link"}</button>
                ) : (
                  <button type="button" className="rx-btn solid" disabled={!amount.trim()} onClick={() => setConfirmCreate(true)}>Continue</button>
                )}
                <button type="button" className="rx-btn" disabled={saving} onClick={() => { setCreating(false); setConfirmCreate(false); }}>Cancel</button>
              </span>
            </div>
          ) : null}
          {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}

/*
 * One person the client's introductions go to: name, role and email saved
 * TOGETHER. The server refuses a name without a role (the sentence reads
 * "<name>, <role>"). Clearing the name and role removes the person.
 */
/* ------------------------------------------------------------- introduction --- */
/* The fields an introduction may use, filled in for each conversation. */
const INTRO_FIELDS: { token: string; label: string }[] = [
  { token: "{{lead.first_name}}", label: "Lead's first name" },
  { token: "{{lead.name}}", label: "Lead's full name" },
  { token: "{{lead.phone_number}}", label: "Lead's phone" },
  { token: "{{lead.email}}", label: "Lead's email" },
  { token: "{{lead.company}}", label: "Lead's brokerage" },
  { token: "{{lead.title}}", label: "Lead's title" },
  { token: "{{sender.name}}", label: "Sender's name" },
  { token: "{{sender.first_name}}", label: "Sender's first name" },
];
const FIELD_LABEL = new Map(INTRO_FIELDS.map((f) => [f.token.replace(/\s/g, ""), f.label]));

/* The text as it will read, with each field shown as a labelled chip. */
function IntroText({ text, onEdit }: { text: string; onEdit?: () => void }) {
  const parts = text.split(/(\{\{\s*[\w.]+\s*\}\})/g);
  return (
    <div className={`rx-intro-text${onEdit ? " editable" : ""}`}
      {...(onEdit ? {
        role: "button", tabIndex: 0, title: "Click to edit the introduction", "aria-label": "Edit the introduction",
        onClick: onEdit, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); onEdit(); } },
      } : {})}
      style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, padding: "12px 14px", border: "1px solid var(--ds-line, #e4e4e7)", borderRadius: 8, background: "var(--ds-subtle, #fafafa)", fontSize: 13.5 }}>
      {parts.map((p, i) => {
        if (!/^\{\{/.test(p)) return <span key={i}>{p}</span>;
        const label = FIELD_LABEL.get(p.replace(/\s/g, "")) ?? p.replace(/[{}\s]/g, "");
        return (
          <span key={i} title={p} style={{ display: "inline-block", padding: "0 6px", margin: "0 1px", borderRadius: 4, background: "#E8F0FE", color: "#1A4FB5", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" }}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function IntroPreview({ clientId, refreshKey, onChanged }: { clientId: string; refreshKey: string; onChanged: () => void }) {
  const [view, setView] = useState<IntroView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState(false);
  const [area, setArea] = useState<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    fetch(`/api/workspace/clients/intro?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (live) setView(body as IntroView);
      })
      .catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [clientId, refreshKey]);

  async function save(custom: string | null) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/workspace/clients/intro", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, custom }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setView(body.view as IntroView);
      setEditing(false); setConfirmReset(false);
      setMsg({
        text: `${custom ? "Saved — the Introduce button and the reply agent now send this introduction" : "Back to the standard introduction"}.${body.template === "failed" ? " The Templates copy could not be updated; the Introduce button uses the new text regardless." : ""}`,
      });
      onChanged();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  function insert(token: string) {
    if (!area) { setDraft((d) => d + token); return; }
    const { selectionStart: a, selectionEnd: b } = area;
    const next = draft.slice(0, a) + token + draft.slice(b);
    setDraft(next);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(a + token.length, a + token.length); });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg({ text: "Could not copy — select the text and copy it instead.", bad: true });
    }
  }

  if (loadError) return <div className="rx-hint" role="alert">The introduction could not be read: {loadError}</div>;
  if (!view) return <div className="rx-hint">Loading the introduction…</div>;

  const current = view.custom ?? view.standard;
  // Editing starts from exactly what is sent today (Eddy, 2 Oct: "I just need to be able to edit this field").
  const startEdit = () => { setDraft(view.custom ?? view.standard ?? ""); setEditing(true); setMsg(null); setConfirmReset(false); };
  const saveDraft = () => {
    const t = draft.trim();
    // Unchanged standard wording is not a custom intro: keep (or go back to) the standard one.
    if (t === (view.standard ?? "").trim()) {
      if (view.custom) void save(null);
      else { setEditing(false); setMsg({ text: "No changes." }); }
      return;
    }
    void save(draft);
  };
  const badge = (on: boolean, text: string) => (
    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".02em", padding: "2px 8px", borderRadius: 999, background: on ? "#EDE7FB" : "#EAF5EE", color: on ? "#5B33B5" : "#1E7A45" }}>{text}</span>
  );

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {view.custom ? badge(true, "Custom introduction") : view.standard ? badge(false, "Standard introduction") : null}
        <span style={{ flex: 1 }} />
        {current && !editing ? (
          <button type="button" className="rx-btn" onClick={() => void copy(current)}>{copied ? "Copied" : "Copy"}</button>
        ) : null}
        {!editing ? (
          <button type="button" className="rx-btn solid" disabled={!view.canSaveCustom}
            title={view.canSaveCustom ? undefined : "Editing the introduction needs database migration 0026 first."}
            onClick={startEdit}>
            Edit intro
          </button>
        ) : null}
        {view.custom && !editing && !confirmReset ? (
          <button type="button" className="rx-btn" onClick={() => setConfirmReset(true)}>Back to standard</button>
        ) : null}
      </div>

      {confirmReset ? (
        <div className="rx-confirm" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>Remove the custom introduction and send the standard one again?</span>
          <button type="button" className="rx-btn solid" disabled={busy || !view.standard}
            title={view.standard ? undefined : "Add the first contact's name and role below first."}
            onClick={() => void save(null)}>{busy ? "Saving…" : "Use standard"}</button>
          <button type="button" className="rx-btn" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel</button>
        </div>
      ) : null}

      {editing ? (
        <div style={{ display: "grid", gap: 8 }}>
          {/* .ds-input fixes inputs at 34px; a textarea sizes by its rows instead,
              growing with the text (one row per line, plus room for wrapping). */}
          <textarea ref={setArea} className="ds-input" aria-label="Introduction" value={draft}
            rows={Math.min(32, Math.max(12, draft.split("\n").length + Math.ceil(draft.length / 90)))}
            placeholder={"Paste the introduction here.\n\nHi {{lead.first_name}}, I'd like to introduce you to…"}
            style={{ width: "100%", minWidth: 0, height: "auto", minHeight: 260, maxHeight: "70vh", overflowY: "auto", resize: "vertical", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.55, padding: "12px 14px" }}
            onChange={(e) => setDraft(e.target.value)} disabled={busy} autoFocus />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
            <span style={{ color: "var(--ds-muted)" }}>Insert a field:</span>
            {INTRO_FIELDS.map((f) => (
              <button key={f.token} type="button" className="rx-btn" style={{ padding: "1px 7px", fontSize: 12 }}
                title={f.token} disabled={busy} onClick={() => insert(f.token)}>{f.label}</button>
            ))}
          </div>
          {draft.trim() ? (
            <>
              <span style={{ fontSize: 12, color: "var(--ds-muted)" }}>How it will read</span>
              <IntroText text={draft.trim()} />
            </>
          ) : null}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="ds-btn primary sm" disabled={busy || !draft.trim()} onClick={saveDraft}>{busy ? "Saving…" : "Save"}</button>
            <button type="button" className="ds-btn ghost sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : current ? (
        <IntroText text={current} onEdit={view.canSaveCustom ? startEdit : undefined} />
      ) : (
        <div className="rx-hint" style={{ marginTop: 0 }}>
          No introduction yet. Add the first contact&apos;s {view.missing.join(" and ")} below, or paste a custom intro.
        </div>
      )}

      {!editing && current ? (
        <div className="rx-hint" style={{ marginTop: 0 }}>
          {view.canSaveCustom ? "Click the text to edit it. " : ""}The highlighted parts are filled in for each lead when it is sent.
          {view.custom
            ? view.routes ? " The people below for each lead's territory are still copied in (Cc)." : " The contacts below are still copied in (Cc)."
            : view.routes ? " It is written from the contacts below; each lead's names only the people for its territory." : " It is written from the contacts below."}
        </div>
      ) : null}
      {!editing && view.routes ? <IntroRoutes routes={view.routes} /> : null}
      {msg ? <div role="status" style={{ fontSize: 13, color: msg.bad ? "var(--x-bad, #b42318)" : undefined }}>{msg.text}</div> : null}
    </div>
  );
}

/*
 * Who each campaign's leads are introduced to, when the client's people have
 * territories (Jeff Cook, 6 Oct). Read-only: it follows from the Territory on
 * each person below, matched against the campaign's name.
 */
function IntroRoutes({ routes }: { routes: NonNullable<IntroView["routes"]> }) {
  const unmatched = routes.filter((r) => r.fallback).length;
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>Who each campaign&apos;s leads are introduced to</div>
      {routes.length ? (
        <div className="rx-camps">
          {routes.map((r) => (
            <div key={r.campaign} className="rx-camp" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <div style={{ minWidth: 0 }}>
                <b title={r.campaign}>{r.campaign}</b>
                <small>
                  {r.conversations} conversation{r.conversations === 1 ? "" : "s"}
                  {r.lastAt ? ` · last ${new Date(r.lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
                  {r.matched.length ? ` · ${r.matched.join(", ")}` : ""}
                </small>
              </div>
              {r.fallback ? (
                <span title="This campaign's name contains none of the territories below, so its leads are introduced to everyone."
                  style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "#FEF3C7", color: "#92400E", whiteSpace: "nowrap" }}>
                  No territory · everyone
                </span>
              ) : (
                <span style={{ fontSize: 12.5, textAlign: "right" }}>{r.people.join(", ")}</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rx-hint" style={{ marginTop: 0 }}>No conversations yet, so no campaigns to show.</div>
      )}
      {unmatched ? (
        <div className="rx-hint" style={{ marginTop: 0 }}>
          {unmatched} campaign{unmatched === 1 ? " names" : "s name"} no territory. Add the place to someone&apos;s Territory below to send those leads to them.
        </div>
      ) : null}
    </div>
  );
}

/** What a saved field looks like on the client, so it shows before the refresh lands. */
function patchFor(key: string, value: unknown): ClientPatch {
  switch (key) {
    case "campaignAliases": return { campaignAliases: (value as string[]) ?? [] };
    case "campaignSender": return { sender: (value as string | null) ?? null };
    default: return { [key]: value } as ClientPatch;
  }
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

function ContactEditor({
  ordinal, value, onSave, startEditing = false, onCancel, onRemove,
}: {
  ordinal: number;
  value: Person;
  onSave: (v: Person) => Promise<void>;
  /** A person being added: open straight in the editor. */
  startEditing?: boolean;
  /** Called when a new person's editor is cancelled. */
  onCancel?: () => void;
  /** People 4+: removable (asks first). */
  onRemove?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState({ name: "", role: "", email: "", territories: "" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${ORDINALS[ordinal] ?? `Contact ${ordinal + 1}`} contact`;

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: draft.name.trim() || null, role: draft.role.trim() || null, email: draft.email.trim() || null,
        territories: draft.territories.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-field" style={{ alignItems: editing ? "start" : "center" }}>
      <div className="ds-field-l"><span>{label}</span><em className="ds-field-src">Master record</em></div>
      <div className="ds-field-v">
        {editing ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <input className="ds-input" placeholder="Full name" aria-label={`${label} name`} value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
              <input className="ds-input" placeholder="Role, e.g. Team Leader" aria-label={`${label} role`} value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
            </div>
            <input className="ds-input" type="email" placeholder="Email (optional)" aria-label={`${label} email`} value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }} />
            <input className="ds-input" placeholder="Territory (optional), e.g. Charleston, Summerville" aria-label={`${label} territory`} value={draft.territories}
              onChange={(e) => setDraft({ ...draft, territories: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }} />
            <span style={{ fontSize: 12, color: "var(--ds-muted)" }}>
              Places this person covers, separated by commas. A lead is introduced to them when one of these is in its campaign name. Leave empty for every lead.
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="ds-btn primary sm" disabled={saving} onClick={() => void commit()}>{saving ? "Saving…" : "Save"}</button>
              <button type="button" className="ds-btn ghost sm" disabled={saving} onClick={() => { setEditing(false); onCancel?.(); }}>Cancel</button>
            </div>
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
          </div>
        ) : (
          <button type="button" className="ds-value" aria-label={`Edit ${label}`}
            onClick={() => { setDraft({ name: value.name ?? "", role: value.role ?? "", email: value.email ?? "", territories: (value.territories ?? []).join(", ") }); setError(null); setEditing(true); }}>
            <span style={{ minWidth: 0 }}>
              {value.name ? (
                <>
                  {value.name}{value.role ? <span style={{ color: "var(--ds-muted)" }}>, {value.role}</span> : null}
                  {value.email ? <span style={{ display: "block", fontSize: 12, color: "var(--ds-muted)" }}>{value.email}</span> : null}
                  {value.territories?.length ? (
                    <span style={{ display: "block", fontSize: 12, color: "var(--ds-muted)" }}>Territory: {value.territories.join(", ")}</span>
                  ) : null}
                </>
              ) : <span className="empty">{ordinal === 0 ? "Not set" : "Add a person"}</span>}
            </span>
            <span className="pen" aria-hidden="true">Edit</span>
          </button>
        )}
        {onRemove && !editing ? (
          confirmRemove ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: 12.5 }}>
              <span>Remove {value.name ?? "this person"}?</span>
              <button type="button" className="ds-btn sm" disabled={saving} style={{ color: "var(--x-bad, #b42318)" }}
                onClick={async () => { setSaving(true); setError(null); try { await onRemove(); } catch (e) { setError(e instanceof Error ? e.message : "Could not remove"); } finally { setSaving(false); setConfirmRemove(false); } }}>
                {saving ? "Removing…" : "Remove"}
              </button>
              <button type="button" className="ds-btn ghost sm" disabled={saving} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="ds-btn ghost sm" style={{ marginTop: 4, fontSize: 12 }} onClick={() => setConfirmRemove(true)}
              aria-label={`Remove ${value.name ?? "this person"}`}>Remove</button>
          )
        ) : null}
        {!editing && error ? <div className="ds-field-err" role="alert">{error}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- people 4+ --- */
/*
 * More than three people to introduce to (client ask, 5 Oct). People 1-3 keep
 * their own editors above; 4 and up are one list (os_clients.more_contacts,
 * migration 0028), saved whole. Up to 10 in all.
 */
type Person = { name: string | null; role: string | null; email: string | null; territories?: string[] };
const MAX_PEOPLE = 10;

function MorePeople({ clientId, contact, onChanged, onPatch }: {
  clientId: string;
  contact: MasterClient["contact"];
  onChanged: () => void;
  onPatch?: (p: ClientPatch) => void;
}) {
  const more: Person[] = contact.extra.slice(2).filter((p) => p.name || p.role || p.email);
  const [adding, setAdding] = useState(false);
  const firstThreeFilled = !!contact.name && !!contact.extra[0]?.name && !!contact.extra[1]?.name;
  const total = 3 + more.length;
  const byTerritory = [contact.territories ?? [], ...contact.extra.map((p) => p.territories ?? [])].some((t) => t.length);

  // The edit route's own rules apply (name + role each, valid email, at most 10);
  // a leg that fails — e.g. migration 0028 not run — comes back as the error.
  async function saveList(next: Person[]) {
    await saveEdit(clientId, { moreContacts: next });
    // People 2-3 stay as they are; 4+ become `next` — on screen at once (6 Oct).
    onPatch?.({ contact: { extra: [...contact.extra.slice(0, 2), ...next] } });
    onChanged();
  }

  return (
    <>
      {more.map((p, i) => (
        <div key={`${i}-${p.name}`} className="rx-row">
          <ContactEditor ordinal={3 + i} value={p}
            onSave={(d) => saveList(more.map((x, j) => (j === i ? d : x)))}
            onRemove={() => saveList(more.filter((_, j) => j !== i))} />
        </div>
      ))}
      {adding ? (
        <div className="rx-row">
          <ContactEditor ordinal={total} value={{ name: null, role: null, email: null }} startEditing
            onCancel={() => setAdding(false)}
            onSave={async (d) => { await saveList([...more, d]); setAdding(false); }} />
        </div>
      ) : null}
      <div className="rx-hint" style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {!adding && total < MAX_PEOPLE ? (
          <button type="button" className="rx-btn" disabled={!firstThreeFilled}
            title={firstThreeFilled ? undefined : "Fill in the first three people, then add more."}
            onClick={() => setAdding(true)}>+ Add a person</button>
        ) : null}
        <span>
          {total >= MAX_PEOPLE ? `${MAX_PEOPLE} people is the most an introduction can name.` :
            byTerritory ? `Each lead is introduced to the people whose territory is in its campaign name, plus anyone with no territory. Up to ${MAX_PEOPLE} people.` :
            firstThreeFilled ? `Everyone here is named in the introduction and copied in. Up to ${MAX_PEOPLE} people.` :
            "Fill in the first three people to add more."}
        </span>
      </div>
    </>
  );
}
