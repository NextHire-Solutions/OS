"use client";

import { useCallback, useEffect, useState } from "react";

/*
 * A client's team, agents and do-not-contact list — shown and edited here.
 *
 * §23 says we should be able to open ONE system and know a client's team and
 * agents; §21 step 6 says an edit should work from either side. Both sides
 * write the same Master Inbox rows, so there is no sync: the OS posts to the
 * client's own portal API, which is the only thing that blocks an address on
 * Instantly and EmailBison before writing the row.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not load the whole list. One client has 2,158 do-not-contact entries
 * and another has 746 agents; a dialog that fetches those is one nobody opens
 * twice. The COUNTS are exact and the most recent 25 are editable — which
 * covers "I just added the wrong person". Bulk work stays in the portal, which
 * is built for it, and the panel says so rather than pretending otherwise.
 */

const LIMIT = 25;

interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  title?: string | null;
  kind?: string | null;
  pushed?: boolean;
}

interface Portal {
  portalId: string;
  portalName: string;
  portalEnabled: boolean;
  team: number;
  agents: number;
  dnc: number;
  recent: { team: PersonRow[]; agents: PersonRow[]; dnc: PersonRow[] };
}

interface People {
  portals: Portal[];
  total: { team: number; agents: number; dnc: number };
  manyPortals: boolean;
}

type Resource = "team" | "agents" | "dnc";

const LABEL: Record<Resource, string> = { team: "Team", agents: "Agents", dnc: "Do not contact" };

const LABEL_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };
const HINT: React.CSSProperties = { fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 };

export function ClientPeople({ clientId }: { clientId: string }) {
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalId, setPortalId] = useState<string>("");
  const [tab, setTab] = useState<Resource>("team");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [extra, setExtra] = useState(""); // title for team, domain for a dnc company
  const [companyKind, setCompanyKind] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/workspace/clients/${clientId}/people`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not read the team");
        return;
      }
      setPeople(body);
      setPortalId((current) =>
        body.portals?.some((p: Portal) => p.portalId === current)
          ? current
          : (body.portals?.[0]?.portalId ?? ""),
      );
    } catch {
      // Zero would read as a statement about the client. Say nothing instead.
      setError("Could not read the team");
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const portal = people?.portals.find((p) => p.portalId === portalId) ?? null;

  async function add() {
    if (busy || !portal) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { portalId: portal.portalId, resource: tab, name };
      if (email.trim()) body.email = email.trim();
      if (tab === "team" && extra.trim()) body.title = extra.trim();
      if (tab === "dnc") {
        body.kind = companyKind ? "company" : "agent";
        if (companyKind && extra.trim()) body.domain = extra.trim();
      }
      const res = await fetch(`/api/workspace/clients/${clientId}/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) {
        setError(out.error ?? "Could not add");
        return;
      }
      setName("");
      setEmail("");
      setExtra("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: PersonRow) {
    if (busy || !portal) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const q = new URLSearchParams({
        portalId: portal.portalId,
        resource: tab,
        personId: row.id,
      });
      const res = await fetch(`/api/workspace/clients/${clientId}/people?${q}`, { method: "DELETE" });
      const out = await res.json();
      if (!res.ok) {
        setError(out.error ?? "Could not remove");
        return;
      }
      if (out.note) setNote(out.note);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !people) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>Team, agents &amp; DNC</span>
        <span style={{ fontSize: 12, color: "var(--warn, #b45309)" }}>{error}</span>
      </div>
    );
  }
  if (!people) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>Team, agents &amp; DNC</span>
        <span style={HINT}>Counting…</span>
      </div>
    );
  }
  if (people.portals.length === 0) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>Team, agents &amp; DNC</span>
        <span style={HINT}>No Master Inbox portal resolves to this client, so there is nothing to show.</span>
      </div>
    );
  }

  const rows = portal ? portal.recent[tab] : [];
  const count = portal ? portal[tab] : 0;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <span style={LABEL_STYLE}>
        Team, agents &amp; DNC <span className="mut">· Master Inbox · edits apply to the live portal</span>
      </span>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
        {(["team", "agents", "dnc"] as const).map((r) => (
          <div key={r}>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{LABEL[r]}</div>
            <div className="tnum" style={{ fontSize: 18, fontWeight: 600 }}>
              {people.total[r].toLocaleString("en-US")}
            </div>
          </div>
        ))}
      </div>

      {people.manyPortals ? (
        <label style={{ display: "grid", gap: 5 }}>
          <span style={LABEL_STYLE}>
            Which portal <span className="mut">· this client works {people.portals.length} markets</span>
          </span>
          <select className="inp" value={portalId} onChange={(e) => setPortalId(e.target.value)}>
            {people.portals.map((p) => (
              <option key={p.portalId} value={p.portalId}>
                {p.portalName} — {p.team} team, {p.agents} agents, {p.dnc} DNC
                {p.portalEnabled ? "" : " (portal off)"}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["team", "agents", "dnc"] as const).map((r) => (
          <button
            key={r}
            type="button"
            className={tab === r ? "btn" : "btn ghost"}
            style={{ fontSize: 12, padding: "4px 10px" }}
            onClick={() => {
              setTab(r);
              setError(null);
              setNote(null);
            }}
          >
            {LABEL[r]} {portal ? portal[r] : 0}
          </button>
        ))}
      </div>

      {error ? <span style={{ fontSize: 12, color: "var(--warn, #b45309)" }}>{error}</span> : null}
      {note ? <span style={HINT}>{note}</span> : null}

      <div style={{ border: "1px solid var(--line)", borderRadius: 8, maxHeight: 190, overflowY: "auto" }}>
        {rows.length === 0 ? (
          <div style={{ ...HINT, padding: 10 }}>Nothing here yet.</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderBottom: "1px solid var(--line-soft)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.name}
                  {row.kind === "company" ? <span className="mut"> · company</span> : null}
                </div>
                <div style={{ ...HINT, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.email ?? "no email"}
                  {row.title ? ` · ${row.title}` : ""}
                  {/* Both providers must have accepted it, or the address is
                      blocked on only one of them. Worth seeing. */}
                  {row.pushed === false ? " · not fully blocked" : ""}
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11, padding: "2px 8px" }}
                disabled={busy}
                onClick={() => void remove(row)}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      {count > rows.length ? (
        <span style={HINT}>
          Showing the {rows.length} most recent of {count.toLocaleString("en-US")}. The full list lives in
          the portal, which is built for bulk work.
        </span>
      ) : null}

      <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
        <input className="inp" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="inp"
          placeholder={tab === "team" ? "Email (required)" : "Email"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {tab === "team" ? (
          <input className="inp" placeholder="Title" value={extra} onChange={(e) => setExtra(e.target.value)} />
        ) : null}
        {tab === "dnc" && companyKind ? (
          <input className="inp" placeholder="Domain to block" value={extra} onChange={(e) => setExtra(e.target.value)} />
        ) : null}
      </div>

      {tab === "dnc" ? (
        <label style={{ display: "flex", gap: 6, alignItems: "center", ...HINT }}>
          <input type="checkbox" checked={companyKind} onChange={(e) => setCompanyKind(e.target.checked)} />
          Block a whole company by domain instead of one address
        </label>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void add()}>
          {busy ? "Working…" : `Add to ${LABEL[tab].toLowerCase()}`}
        </button>
        <span style={HINT}>
          {tab === "team"
            ? "Notification roster only — no email is sent to them by campaigns."
            : "Adding blocks this address on Instantly and EmailBison before the row is saved."}
        </span>
      </div>
    </div>
  );
}
