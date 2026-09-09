"use client";

import { useMemo, useState } from "react";

import type { MasterInboxSettings } from "@/lib/tools/master-inbox/settings";
import { dateStamp } from "@/lib/workspace/dates";
import { Lazy, PlaceholderScreen } from "../lazy";

/*
 * Master Inbox — settings.
 *
 * The tool has eight screens here; this shows what they contain, in one place
 * with tabs, because they are consulted far more often than they are changed.
 *
 * Read-only, and the screen says so once rather than putting a disabled button
 * beside every row. Editing is worth doing properly — a labels editor renames
 * a label that 260 threads carry, and a templates editor changes what gets
 * sent to agents.
 *
 * No secret reaches the browser: the loader never selects the encrypted
 * provider key or a client's Follow Up Boss key, and reduces "is one set" to a
 * boolean on the server.
 */

type Tab = "labels" | "templates" | "agents" | "views" | "members";

const TABS: { id: Tab; label: string }[] = [
  { id: "labels", label: "Labels" },
  { id: "templates", label: "Reply Templates" },
  { id: "agents", label: "Reply Agents" },
  { id: "views", label: "Custom Views" },
  { id: "members", label: "Members" },
];

export function MasterInboxSettingsScreen({ initial }: { initial: MasterInboxSettings | null }) {
  return (
    <Lazy<MasterInboxSettings>
      initial={initial}
      url="/api/tools/master-inbox/settings"
      label="Settings"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {(data) => <SettingsView data={data} />}
    </Lazy>
  );
}

function SettingsView({ data }: { data: MasterInboxSettings }) {
  const [tab, setTab] = useState<Tab>("labels");
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const labels = useMemo(
    () => data.labels.filter((l) => !q || l.name.toLowerCase().includes(q)),
    [data.labels, q],
  );
  const templates = useMemo(
    () =>
      data.templates.filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          (t.category ?? "").toLowerCase().includes(q) ||
          t.preview.toLowerCase().includes(q),
      ),
    [data.templates, q],
  );

  if (data.error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Settings could not be read.</b> {data.error}
        </div>
      </div>
    );
  }

  const counts: Record<Tab, number> = {
    labels: data.labels.length,
    templates: data.templates.length,
    agents: data.agents.length,
    views: data.views.length,
    members: data.members.length,
  };

  return (
    <div className="wrap">
      <div className="anno" style={{ marginBottom: 16 }}>
        <b>Reading only.</b> Editing still happens in Master Inbox — renaming a label
        changes it on every thread carrying it, and a template change alters what
        gets sent to agents, so the editors are being built deliberately.
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <Card label="Labels" value={data.labels.length} sub="across the workspace" />
        <Card label="Reply Templates" value={data.templates.length} sub="available in the composer" />
        <Card label="Custom Views" value={data.views.length} sub="saved filters" />
        <Card label="Clients" value={data.clients} sub="in Master Inbox" />
      </div>

      <div className="pills" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`fp${tab === t.id ? " on" : ""}`}
            onClick={() => { setTab(t.id); setSearch(""); }}
            aria-pressed={tab === t.id}
          >
            {t.label}
            <span className="tnum" style={{ marginLeft: 7, opacity: 0.6 }}>{counts[t.id]}</span>
          </button>
        ))}
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">{TABS.find((t) => t.id === tab)?.label}</div>
            <div className="tbl-sub">{subtitleFor(tab)}</div>
          </div>
          {tab === "labels" || tab === "templates" ? (
            <input
              className="inp"
              placeholder={`Search ${tab}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={`Search ${tab}`}
            />
          ) : null}
        </div>

        <div className="tbl-scroll">
          {tab === "labels" ? (
            <table style={{ minWidth: 620 }}>
              <thead>
                <tr><th>Label</th><th>Sentiment</th><th>Threads</th></tr>
              </thead>
              <tbody>
                {labels.length === 0 ? <Empty colSpan={3} q={search} /> : labels.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="tg" style={{ background: l.color || "var(--inset-2)", borderColor: "transparent" }}>
                        {l.name}
                      </span>
                    </td>
                    <td className="mut">{l.sentiment ?? <span className="api-none">—</span>}</td>
                    <td>
                      {l.threads > 0
                        ? <span className="api-num tnum">{l.threads.toLocaleString("en-US")}</span>
                        : <span className="tnum" style={{ color: "var(--muted)" }}>0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {tab === "templates" ? (
            <table style={{ minWidth: 860 }}>
              <thead>
                <tr><th>Template</th><th>Category</th><th>Subject</th><th>Preview</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {templates.length === 0 ? <Empty colSpan={5} q={search} /> : templates.map((t) => (
                  <tr key={t.id}>
                    <td><div className="cname">{t.name}</div></td>
                    <td>{t.category ? <span className="tg">{t.category}</span> : <span className="api-none">—</span>}</td>
                    <td className="mut">{t.subject ?? <span className="api-none">—</span>}</td>
                    <td className="mut" style={{ maxWidth: 340, fontSize: 12.5 }}>{t.preview || <span className="api-none">—</span>}</td>
                    <td className="mut tnum">{dateStamp(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {tab === "agents" ? (
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr><th>Agent</th><th>Mode</th><th>Model</th><th>Active</th><th>Auto-respond</th><th>API key</th></tr>
              </thead>
              <tbody>
                {data.agents.length === 0 ? <Empty colSpan={6} q="" /> : data.agents.map((a) => (
                  <tr key={a.id}>
                    <td><div className="cname">{a.name}</div></td>
                    <td className="mut">{a.mode ?? <span className="api-none">—</span>}</td>
                    <td className="mut">{[a.provider, a.model].filter(Boolean).join(" · ") || <span className="api-none">—</span>}</td>
                    <td>
                      <span className={`badge ${a.active ? "s-done" : "s-pending"}`}>
                        <span className="dot" />{a.active ? "Active" : "Off"}
                      </span>
                    </td>
                    <td className="mut">
                      {a.autoRespond ? (
                        <span className="tg" style={{ background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }}>
                          replies automatically
                        </span>
                      ) : "—"}
                    </td>
                    {/* Whether a key is set, never the key. */}
                    <td className="mut">{a.hasKey ? "set" : <span className="api-none">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {tab === "views" ? (
            <table style={{ minWidth: 460 }}>
              <thead><tr><th>View</th><th>Slug</th></tr></thead>
              <tbody>
                {data.views.length === 0 ? <Empty colSpan={2} q="" /> : data.views.map((v) => (
                  <tr key={v.id}>
                    <td><div className="cname">{v.name}</div></td>
                    <td className="mut">{v.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {tab === "members" ? (
            <table style={{ minWidth: 520 }}>
              <thead><tr><th>Member</th><th>Role</th><th>Status</th></tr></thead>
              <tbody>
                {data.members.length === 0 ? <Empty colSpan={3} q="" /> : data.members.map((m) => (
                  <tr key={m.userId}>
                    {/* The id, because the tool stores no email on this table
                        and inventing a display name would be a fiction. */}
                    <td className="mut" style={{ fontSize: 12.5 }}>{m.userId}</td>
                    <td>{m.role ? <span className="tg">{m.role}</span> : <span className="api-none">—</span>}</td>
                    <td className="mut">{m.status ?? <span className="api-none">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function subtitleFor(tab: Tab): string {
  switch (tab) {
    case "labels": return "Every label, and how many threads carry it";
    case "templates": return "What the composer offers";
    case "agents": return "Automatic replies, and whether they are switched on";
    case "views": return "Saved filters that appear in the inbox rail";
    case "members": return "Who has access to Master Inbox";
  }
}

function Empty({ colSpan, q }: { colSpan: number; q: string }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
        {q.trim() ? `Nothing matches “${q.trim()}”.` : "Nothing here yet."}
      </td>
    </tr>
  );
}

function Card({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className="card-n tnum">{value.toLocaleString("en-US")}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
