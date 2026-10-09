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
import { ClientCountLine, rowNote, useClientCounts } from "@/components/clients/count-line";

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
  /** Set when this row is a client in the master record. */
  masterId?: string | null;
}

interface Unassigned {
  campaignId: string;
  platform: "emailbison" | "instantly";
  name: string;
  status: string;
  lifetimeSent: number;
  ambiguous: boolean;
  /** The Analytics client the Database files this campaign under, if any. */
  databaseClientId: string | null;
}

interface Conflict {
  campaignId: string;
  platform: "emailbison" | "instantly";
  name: string;
  currentClientId: string;
  databaseClientId: string;
}

interface ClientsResponse {
  clients: Client[];
  unassigned: Unassigned[];
  conflicts?: Conflict[];
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
  // Marks the rows that are not one more client (second portals, non-clients).
  const counts = useClientCounts();
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
  const conflicts = data?.conflicts ?? [];
  const clientName = (id: string) => data?.clients.find((c) => c.id === id)?.name ?? null;

  return (
    <div className="an-screen">
    <StalenessStrip />
    <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
      <ClientCountLine tool="analytics" />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="ds-kicker">Campaign Management</span>
          <h1 className="ds-title">Clients</h1>
          <div className="tbl-sub">
            {data
              ? `${data.clients.length} rows · ${data.excludedCount} campaigns excluded from analytics`
              : "Loading…"}
          </div>
        </div>
        {/* §2/§13: clients are created once, on the Clients page — never here. */}
        <a className="ds-btn" href="/roster">Clients are added on Clients →</a>
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
                        {/*
                          The Database's answer, one click away. Accepting it is
                          a manual pin — the same write as the dropdown — so
                          neither name matcher can undo it.
                        */}
                        {u.databaseClientId && clientName(u.databaseClientId) ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <span className="mut" style={{ fontSize: 12.5 }}>
                              Database: <b>{clientName(u.databaseClientId)}</b>
                            </span>
                            <Btn
                              disabled={busy}
                              aria-label={`Assign ${u.name} to ${clientName(u.databaseClientId)}`}
                              onClick={() =>
                                void run(`“${u.name}” assigned to ${clientName(u.databaseClientId!)}`, () =>
                                  assignCampaign(u.campaignId, u.databaseClientId),
                                )
                              }
                            >
                              Assign
                            </Btn>
                          </div>
                        ) : null}
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

      {/*
        Where the Database and Analytics' name matching disagree about a
        campaign's client. Neither is assumed right, so both are offered.
      */}
      {conflicts.length ? (
        <Box
          title={`${conflicts.length} campaign${conflicts.length === 1 ? "" : "s"} the Database files under a different client`}
          note="Matched here by name, but the Database's own record names another client. Pin whichever is right; a pin is never recomputed."
          style={{ borderColor: "#F6DFC0" }}
        >
          <div className="tbl-scroll">
            <table className="atbl" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th style={{ width: 230 }}>Matched by name</th>
                  <th style={{ width: 230 }}>Database says</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={`${c.platform}-${c.campaignId}`}>
                    <td><div className="cname" style={{ fontSize: 13.5 }}>{c.name}</div></td>
                    {[c.currentClientId, c.databaseClientId].map((id) => (
                      <td key={id}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span>{clientName(id) ?? "—"}</span>
                          <Btn
                            disabled={busy || !clientName(id)}
                            aria-label={`Pin ${c.name} to ${clientName(id)}`}
                            onClick={() =>
                              void run(`“${c.name}” pinned to ${clientName(id)}`, () => assignCampaign(c.campaignId, id))
                            }
                          >
                            Pin
                          </Btn>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Box>
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
                            await run(`Saved “${name}”`, async () => {
                              /*
                               * §15 — a client's aliases live in three stores
                               * (master, Analytics, Client Health) and must
                               * agree. For a real client, save them through
                               * the client record, which writes all three;
                               * this used to write Analytics alone, which the
                               * daily check reports as alias drift. Refused as
                               * a whole if that fails, so nothing drifts.
                               */
                              const changed = aliases.join("\n") !== c.aliases.join("\n");
                              if (c.masterId && changed) {
                                const res = await fetch("/api/workspace/clients/edit", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: c.masterId, aliases }),
                                });
                                const b = await res.json().catch(() => null);
                                if (!res.ok || b?.failed?.length) {
                                  throw new Error(b?.error ?? b?.failed?.[0]?.error ?? `HTTP ${res.status}`);
                                }
                              }
                              return updateClient(c.id, { name, aliases, matchMode });
                            });
                            setEditing(null);
                          }}
                          /*
                           * A real client is deleted from the Clients page,
                           * which removes it from every tool (and pauses its
                           * campaigns and billing first). Deleting only this
                           * row left a client in four tools and missing here.
                           */
                          onDelete={c.masterId ? undefined : async () => {
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
                        {rowNote(counts, "analytics", c.name) ? <div className="csince">{rowNote(counts, "analytics", c.name)}</div> : null}
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
