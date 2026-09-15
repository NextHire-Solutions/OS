"use client";

import type { ClientDetail, TeamMember } from "@/lib/tools/onboarding/client-detail";
import type { LeadList } from "@/lib/tools/onboarding/client-leads";
import { Lazy } from "../lazy";
import { clientLeadsUrl } from "./actions";

/*
 * The client's three list tabs, ported from the orchestrator's
 * `/clients/[id]/{leads,agents,team}` pages.
 *
 * All three are READS. Nothing on them writes, in the tool or here — they exist
 * so a human can check a list before a step acts on it, which is the whole
 * reason the lead review page was built.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DISTINCTION THAT MATTERS ON THESE PAGES
 *
 * `orch_client_team` holds three different kinds of person in one table, and
 * confusing them would put a do-not-contact name onto a list we email:
 *
 *   Team    source = "typeform", not DNC — the client's own staff we work with.
 *           They receive introductions and onboarding emails.
 *   Agents  source ≠ "typeform" — their roster, matched from the scraped
 *           database by firm name. NEVER contacted, excluded from every list.
 *   DNC     source = "typeform", is_dnc — offices and people the client asked
 *           us to avoid, from their intake answers.
 *
 * The split is made once, server-side, in `client-detail.ts`.
 */

const money = (n: number | null) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function Panel({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-lg)",
        boxShadow: "var(--sh-card)",
        marginBottom: 20,
        overflow: "hidden",
      }}
    >
      <div className="tbl-head">
        <div>
          <div className="tbl-title">{title}</div>
          {sub && <div className="tbl-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "34px 22px", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
      {children}
    </div>
  );
}

/* ================================ TEAM =================================== */

export function ClientTeamTab({ data }: { data: ClientDetail }) {
  const { team, client } = data;
  return (
    <Panel
      title={`Team (${team.length})`}
      sub="The client's own people we work with — the form filler plus anyone they named for introductions. They receive introductions and onboarding emails."
    >
      {team.length === 0 ? (
        <Empty>
          No team contacts yet — taken from the intake form (form filler plus anyone named for
          introductions) when the copy is approved and “Build team” runs.
        </Empty>
      ) : (
        <div className="tbl-scroll">
          <table style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Email</th>
                <th>Phone</th>
                <th>In portal</th>
              </tr>
            </thead>
            <tbody>
              {team.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="cname">{t.name ?? "—"}</div>
                  </td>
                  <td>{t.role ?? <span className="api-none">—</span>}</td>
                  <td className="mut">{t.email ?? "—"}</td>
                  <td className="mut">{t.phone ?? "—"}</td>
                  <td>
                    {client.portalUrl ? (
                      <a
                        href={`${client.portalUrl}/team`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--blue)", fontWeight: 600 }}
                      >
                        Team tab ↗
                      </a>
                    ) : (
                      <span className="api-none">portal not created yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* =============================== AGENTS ================================== */

function AgentRows({ rows }: { rows: TeamMember[] }) {
  return (
    <div className="tbl-scroll">
      <table style={{ minWidth: 860 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Title</th>
            <th>Email</th>
            <th>Phone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <div className="cname">{t.name ?? "—"}</div>
              </td>
              <td className="mut">{t.role ?? "—"}</td>
              <td className="mut">{t.email ?? <span className="api-none">no email on file</span>}</td>
              <td className="mut">{t.phone ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClientAgentsTab({ data }: { data: ClientDetail }) {
  const { roster, dnc, client } = data;
  return (
    <>
      <Panel
        title={`Their agents (${roster.length})`}
        sub="Matched from the scraped database by the client's firm name. We never reach out to these people, and they are excluded from every lead list by name."
      >
        {roster.length === 0 ? (
          <Empty>Not built yet — filled in when “Build team” runs.</Empty>
        ) : (
          <AgentRows rows={roster} />
        )}
      </Panel>

      <Panel
        title={`Do not contact (${dnc.length})`}
        sub={
          <>
            Offices and agents the client asked us to avoid, from their intake answers.
            {client.portalUrl && (
              <>
                {" "}
                Also on their{" "}
                <a
                  href={`${client.portalUrl}/dnc`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--blue)", fontWeight: 600 }}
                >
                  portal DNC list ↗
                </a>
              </>
            )}
          </>
        }
      >
        {dnc.length === 0 ? (
          <Empty>No exclusions given in the intake form.</Empty>
        ) : (
          <div className="tbl-scroll">
            <table style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {dnc.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="cname">{t.name ?? "—"}</div>
                    </td>
                    <td>
                      <span className="badge s-risk">
                        <span className="dot" />
                        DNC
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/* ================================ LEADS ================================== */

function LeadsView({ list, data }: { list: LeadList; data: ClientDetail }) {
  const c = data.client;

  if (list.error) {
    return (
      <div className="anno" style={{ margin: "0 0 18px" }}>
        <b>The lead list could not be read.</b> {list.error}
      </div>
    );
  }

  return (
    <>
      {/* Where the list stands: built, handed to the DB app, or already in the
          campaign. The tool leads with this because the number alone does not
          say whether anyone is acting on it. */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--sh-card)",
          padding: "16px 22px",
          marginBottom: 20,
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {c.leadsExported ? (
          <>
            <span className="badge s-done">
              <span className="dot" />
              leads in campaign
            </span>
            <span className="tbl-sub">Imported into the EmailBison campaign.</span>
          </>
        ) : c.leadsInReview ? (
          <>
            <span className="badge s-pending">
              <span className="dot" />
              with the DB app
            </span>
            <span className="tbl-sub">Review and enrichment happen there; this is a read-only view.</span>
          </>
        ) : list.total > 0 ? (
          <>
            <span className="badge s-ok">
              <span className="dot" />
              list built
            </span>
            <span className="tbl-sub">Not yet handed to the DB app — rebuild the list to hand it off.</span>
          </>
        ) : (
          <span className="api-none">No list built yet.</span>
        )}
      </div>

      <Panel
        title={`Lead list — ${list.total.toLocaleString("en-US")} leads`}
        sub={
          list.rows.length < list.total
            ? `Showing the top ${list.rows.length.toLocaleString("en-US")} by sales volume.`
            : "Sorted by sales volume. Built from the database with this client's filters, minus their own agents and DNC."
        }
      >
        {list.total === 0 ? (
          <Empty>
            No leads yet. The lead list is built by the “Build lead list” step, which is one of the
            fourteen the OS does not fire.
          </Empty>
        ) : (
          <div className="tbl-scroll">
            <table style={{ minWidth: 1240 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Title</th>
                  <th>Brand</th>
                  <th>Office</th>
                  <th>City</th>
                  <th>Sales volume</th>
                  <th>Closed txns</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((l, i) => (
                  <tr key={l.agentId}>
                    <td className="mut tnum">{i + 1}</td>
                    <td>
                      <div className="cname">{l.fullName ?? "—"}</div>
                    </td>
                    <td className="mut" title={l.email ?? undefined}>
                      {l.email ?? "—"}
                    </td>
                    <td>{l.title ?? <span className="api-none">—</span>}</td>
                    <td>{l.brand ?? <span className="api-none">—</span>}</td>
                    <td>{l.officeName ?? <span className="api-none">—</span>}</td>
                    <td>{l.officeCity ?? <span className="api-none">—</span>}</td>
                    <td className="tnum">{money(l.salesVolume)}</td>
                    <td className="tnum">{l.closedTransactions ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export function ClientLeadsTab({ data }: { data: ClientDetail }) {
  return (
    <Lazy<LeadList> initial={null} url={clientLeadsUrl(data.client.id)} label="The lead list">
      {(list) => <LeadsView list={list} data={data} />}
    </Lazy>
  );
}
