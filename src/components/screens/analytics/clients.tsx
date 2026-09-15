"use client";

import { useMemo, useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";
import {
  CLIENTS_URL,
  REPLY_DIMENSIONS_URL,
  assignCampaign,
  createClient,
  removeClient,
  setReplyDimension,
  updateClient,
  useAnalyticsData,
  type MatchMode,
} from "./actions";
import { Box, EmptyRow, LoadError, Search, SortHeader, sortRows, useSort } from "./shared";
import { StalenessStrip } from "./staleness-strip";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — Clients.
 *
 * The tool's `/clients`, and the most consequential screen in the product to
 * get right. `campaign_clients` is what every analytics RPC joins through:
 * a campaign with no client is a campaign whose volume lands in the KPI band
 * and in nobody's row, and a campaign pinned to the wrong client silently
 * misreports two clients at once. Nothing on any other screen would look broken.
 *
 * So the unassigned queue is FIRST, above the roster, because it is the only
 * thing on this page that is actually a task. `excluded` campaigns are left out
 * of it deliberately: they are a settled decision, not outstanding work, and
 * including them would mean the queue never reaches zero.
 *
 * Three writes live here, all against Analytics' own database:
 *   · create / rename / re-alias / delete a client   (`clients`)
 *   · pin a campaign to a client                     (`campaign_clients`)
 *   · turn a reply breakdown on or off for a client  (`reply_dimensions`)
 *
 * Deleting a client is safe by construction: `campaign_clients.client_id` is
 * ON DELETE SET NULL, so its campaigns return to the unassigned queue rather
 * than disappearing. The armed button says so before the second click.
 */

interface Client {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  matchMode: MatchMode;
  active: boolean;
  campaignCount: number;
  manualCount: number;
  instantlyCount: number;
}

interface Unassigned {
  campaignId: string;
  platform: "emailbison" | "instantly";
  name: string;
  status: string;
  lifetimeSent: number;
  ambiguous: boolean;
}

interface ClientsResponse {
  clients: Client[];
  unassigned: Unassigned[];
  excludedCount: number;
}

interface Dimension {
  key: string;
  label: string;
  source: string;
  active: boolean;
  overridden: boolean;
}

const MATCH_MODES: Array<{ value: MatchMode; label: string; hint: string }> = [
  { value: "contains", label: "Contains", hint: "the name appears anywhere in the campaign name" },
  { value: "prefix", label: "Prefix", hint: "the campaign name starts with it" },
  { value: "exact", label: "Exact", hint: "the whole campaign name is the client name" },
];

export function AnalyticsClientsScreen() {
  const { data, error, loading, reload } = useAnalyticsData<ClientsResponse>(CLIENTS_URL);
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(true);
  const { sort, toggle } = useSort();

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      show({ text: what });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = (data?.clients ?? []).filter(
      (c) => !needle || c.name.toLowerCase().includes(needle) || c.aliases.some((a) => a.toLowerCase().includes(needle)),
    );
    return sortRows(base, sort, (c, key) => (c as unknown as Record<string, number | string | null>)[key]);
  }, [data, q, sort]);

  if (error) return <LoadError what="The client roster" error={error} />;

  const queue = data?.unassigned ?? [];

  return (
    <div className="an-screen">
    <StalenessStrip />
    <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>Clients</div>
          <div className="tbl-sub">
            {data
              ? `${data.clients.length} clients · ${data.excludedCount} campaigns excluded from analytics`
              : "Loading…"}
          </div>
        </div>
        <Btn primary disabled={busy} onClick={() => setAdding(true)}>Add client</Btn>
      </div>

      {queue.length ? (
        <Box
          title={`${queue.length} campaign${queue.length === 1 ? "" : "s"} with no client`}
          note="Their volume counts in the KPI band and in nobody's row. This is the only place to fix that."
          right={
            <Btn onClick={() => setShowQueue((v) => !v)}>{showQueue ? "Hide" : "Show"}</Btn>
          }
          style={{ borderColor: "#F6DFC0" }}
        >
          {showQueue ? (
            <div className="tbl-scroll">
              <table className="atbl" style={{ minWidth: 860 }}>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th style={{ width: 110 }}>Platform</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 120, textAlign: "right" }}>Lifetime sent</th>
                    <th style={{ width: 250 }}>Assign to client</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((u) => (
                    <tr key={`${u.platform}-${u.campaignId}`}>
                      <td>
                        <div className="cname" style={{ fontSize: 13.5 }}>{u.name}</div>
                        {u.ambiguous ? (
                          <div className="csince">
                            <span className="badge s-ok">matched 2+ clients</span> left unassigned
                            rather than guessed
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`c ${u.platform === "instantly" ? "c-bison" : "c-inst"}`}>
                          {u.platform === "instantly" ? "Instantly" : "EmailBison"}
                        </span>
                      </td>
                      <td className="mut">{u.status}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(u.lifetimeSent)}</td>
                      <td>
                        <select
                          className="sel"
                          disabled={busy}
                          value=""
                          aria-label={`Assign ${u.name} to a client`}
                          style={{ width: "100%" }}
                          onChange={(e) => {
                            const clientId = e.target.value;
                            if (!clientId) return;
                            const name = data?.clients.find((c) => c.id === clientId)?.name ?? "a client";
                            void run(`“${u.name}” assigned to ${name}`, () =>
                              assignCampaign(u.campaignId, clientId),
                            );
                          }}
                        >
                          <option value="">Assign to client…</option>
                          {(data?.clients ?? []).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Box>
      ) : data ? (
        <div className="anno new" style={{ margin: "0 0 20px" }}>
          <b>Every campaign has a client.</b> Nothing is falling out of the client totals.
        </div>
      ) : null}

      <Box
        title="The roster"
        note="A client is matched to a campaign by its name appearing in the campaign's. Aliases absorb the other spellings."
        right={<Search value={q} onChange={setQ} placeholder="Search clients…" />}
      >
        {adding ? (
          <ClientForm
            title="New client"
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={async (name, aliases, matchMode) => {
              await run(`Added “${name}”`, () => createClient(name, aliases, matchMode));
              setAdding(false);
            }}
          />
        ) : null}

        <div className="tbl-scroll">
          <table className="atbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <SortHeader label="Client" sortKey="name" sort={sort} onToggle={toggle} width={260} />
                <th>Aliases</th>
                <SortHeader label="Match" sortKey="matchMode" sort={sort} onToggle={toggle} width={120} />
                <SortHeader label="Campaigns" sortKey="campaignCount" sort={sort} onToggle={toggle} align="right" width={130} />
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={5}>{data ? "No client matches." : "Loading…"}</EmptyRow>
              ) : (
                rows.map((c) =>
                  editing === c.id ? (
                    <tr key={c.id}>
                      <td colSpan={5} style={{ padding: 0 }}>
                        <ClientForm
                          title={`Edit “${c.name}”`}
                          initialName={c.name}
                          initialAliases={c.aliases}
                          initialMode={c.matchMode}
                          busy={busy}
                          clientId={c.id}
                          onCancel={() => setEditing(null)}
                          onSave={async (name, aliases, matchMode) => {
                            await run(`Saved “${name}”`, () =>
                              updateClient(c.id, { name, aliases, matchMode }),
                            );
                            setEditing(null);
                          }}
                          onDelete={async () => {
                            await run(`Deleted “${c.name}”`, () => removeClient(c.id));
                            setEditing(null);
                          }}
                          deleteTitle={`Delete “${c.name}”? Its ${c.campaignCount} campaign${c.campaignCount === 1 ? "" : "s"} return to the unassigned queue — no campaign data is deleted.`}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td>
                        <div className="cname">{c.name}</div>
                        {!c.active ? <div className="csince">inactive</div> : null}
                      </td>
                      <td>
                        {c.aliases.length === 0 ? (
                          <span className="api-none">none</span>
                        ) : (
                          <span className="chips">
                            {c.aliases.map((a) => (
                              <span key={a} className="c c-camp">{a}</span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="mut">{c.matchMode}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {c.campaignCount}
                        {c.manualCount > 0 ? (
                          <span className="csince"> ({c.manualCount} pinned)</span>
                        ) : null}
                        {c.instantlyCount > 0 ? (
                          <div className="csince">{c.instantlyCount} on Instantly</div>
                        ) : null}
                      </td>
                      <td>
                        <Btn disabled={busy} onClick={() => setEditing(c.id)}>Edit</Btn>
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </Box>
      <Toast toast={toast} />
    </div>
    </div>
  );
}

function ClientForm({
  title,
  initialName = "",
  initialAliases = [],
  initialMode = "contains",
  busy,
  clientId,
  onSave,
  onCancel,
  onDelete,
  deleteTitle,
}: {
  title: string;
  initialName?: string;
  initialAliases?: string[];
  initialMode?: MatchMode;
  busy: boolean;
  clientId?: string;
  onSave: (name: string, aliases: string[], mode: MatchMode) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  deleteTitle?: string;
}) {
  const [name, setName] = useState(initialName);
  const [aliases, setAliases] = useState<string[]>(initialAliases);
  const [alias, setAlias] = useState("");
  const [mode, setMode] = useState<MatchMode>(initialMode);

  return (
    <div style={{ padding: 18, background: "var(--inset)", borderBottom: "1px solid var(--line-soft)" }}>
      <div className="card-l" style={{ marginBottom: 10 }}>{title}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "block" }}>
          <span className="as-l">Name</span>
          <input
            className="inp" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            style={{ minWidth: 240 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="as-l">Add an alias</span>
          <input
            className="inp" value={alias}
            placeholder="another spelling seen in campaign names"
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && alias.trim()) {
                e.preventDefault();
                setAliases((a) => [...new Set([...a, alias.trim()])]);
                setAlias("");
              }
            }}
            style={{ minWidth: 260 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="as-l">Match mode</span>
          <select className="sel" value={mode} onChange={(e) => setMode(e.target.value as MatchMode)}>
            {MATCH_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label} — {m.hint}</option>
            ))}
          </select>
        </label>
        <Btn primary disabled={busy || !name.trim()} onClick={() => void onSave(name.trim(), aliases, mode)}>
          Save
        </Btn>
        <Btn disabled={busy} onClick={onCancel}>Cancel</Btn>
        {onDelete ? (
          <ConfirmButton
            label="Delete"
            armedLabel="Confirm delete"
            title={deleteTitle ?? "Delete this client?"}
            disabled={busy}
            onConfirm={() => void onDelete()}
          />
        ) : null}
      </div>

      {aliases.length ? (
        <div className="chips" style={{ marginTop: 12 }}>
          {aliases.map((a) => (
            <button
              key={a}
              type="button"
              className="c c-camp"
              title={`Remove ${a}`}
              style={{ cursor: "pointer" }}
              onClick={() => setAliases((list) => list.filter((x) => x !== a))}
            >
              {a} ×
            </button>
          ))}
        </div>
      ) : null}

      {clientId ? <ReplyGroupings clientId={clientId} busy={busy} /> : null}
    </div>
  );
}

/**
 * Which reply breakdowns this client sees on the Campaign screen.
 *
 * Copy-on-write: turning one off writes a client-specific row rather than
 * editing the shared `client_id IS NULL` default. Deleting the default would
 * remove the card for every client at once, which is a very quiet way to break
 * everyone's dashboard.
 */
function ReplyGroupings({ clientId, busy }: { clientId: string; busy: boolean }) {
  const { data, reload } = useAnalyticsData<{ dimensions: Dimension[] }>(
    REPLY_DIMENSIONS_URL(clientId),
  );
  const [saving, setSaving] = useState(false);
  const { toast, show } = useToast();

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <div className="card-l" style={{ marginBottom: 8 }}>
        Reply breakdowns for this client
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {(data?.dimensions ?? []).map((d) => (
          <label
            key={d.key}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={d.active}
              disabled={busy || saving}
              style={{ accentColor: "var(--blue)", cursor: "pointer" }}
              onChange={async (e) => {
                setSaving(true);
                try {
                  await setReplyDimension(clientId, d.key, e.target.checked);
                  await reload();
                  show({ text: `${d.label} ${e.target.checked ? "shown" : "hidden"} for this client` });
                } catch (err) {
                  show({ text: err instanceof Error ? err.message : "Could not save", bad: true });
                } finally {
                  setSaving(false);
                }
              }}
            />
            {d.label}
            {d.overridden ? <span className="c c-camp">custom</span> : null}
          </label>
        ))}
        {data && data.dimensions.length === 0 ? (
          <span className="mut">No breakdowns configured.</span>
        ) : null}
      </div>
      <Toast toast={toast} />
    </div>
  );
}
