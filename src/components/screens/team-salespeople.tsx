"use client";

import { useCallback, useEffect, useState } from "react";

/*
 * Team access → Salespeople.
 *
 * "Just for our records" (the client, 30 Sep): the people who sell, whether
 * or not they ever sign in. A client's Salesperson is chosen from this list on
 * its record in Clients. Renaming someone here renames them on every client
 * that names them, and in Onboarding. Deactivating takes them out of the
 * picker and leaves their clients as they are.
 *
 * The email is optional: set it to the address they sign in with and they can
 * see their own commissions. The residual rate is theirs — 15% or 25%.
 */

interface Person {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  rates: { monthOne: number; residual: number };
  clients: number | null;
}

const LINK = { background: "none", border: 0, padding: 0, color: "var(--blue)", cursor: "pointer", font: "inherit", fontSize: 12.5 } as const;

async function call(method: "POST" | "PATCH", body: Record<string, unknown>) {
  const res = await fetch("/api/admin/salespeople", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
  return out as { clientsRenamed?: number };
}

export function SalespeopleSection() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; email: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/salespeople", { cache: "no-store" });
      const out = await res.json();
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      setAvailable(out.available);
      setPeople(out.people);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the Salespeople list");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key); setNote(null);
    try { setNote({ text: await fn() }); await load(); }
    catch (e) { setNote({ text: e instanceof Error ? e.message : "Could not save", bad: true }); }
    finally { setBusy(null); }
  }

  const add = () => run("add", async () => {
    await call("POST", { name, email: email.trim() || null });
    const added = name.trim();
    setName(""); setEmail("");
    return `${added} added.`;
  });

  const saveEdit = () => editing && run(editing.id, async () => {
    const before = people?.find((p) => p.id === editing.id);
    const out = await call("PATCH", { id: editing.id, name: editing.name, email: editing.email.trim() || null });
    setEditing(null);
    const renamed = before && before.name !== editing.name.trim() && out.clientsRenamed
      ? ` ${out.clientsRenamed} client${out.clientsRenamed === 1 ? "" : "s"} now say ${editing.name.trim()}.` : "";
    return `Saved.${renamed}`;
  });

  return (
    <section style={{ marginTop: 36 }} aria-labelledby="sp-h">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 12 }}>
        <div>
          <h2 id="sp-h" style={{ fontSize: 17, fontWeight: 650, margin: 0 }}>Salespeople</h2>
          <p style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 4 }}>
            Who sells, kept for our records — they don&rsquo;t need to sign in. A client&rsquo;s Salesperson is chosen from this list on its record in Clients.
          </p>
        </div>
      </div>

      {error ? <div className="anno" style={{ margin: "0 0 12px" }}><b>Could not load the list.</b> {error}</div> : null}
      {!available ? (
        <div className="anno" style={{ margin: "0 0 12px" }}>
          <b>The Salespeople list is not set up yet.</b> Run <code>migrations/0020_salespeople.sql</code> in Supabase once.
        </div>
      ) : null}

      {available ? (
        <form
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add(); }}
        >
          <input className="inp" id="sp-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name"
            aria-label="New salesperson's name" style={{ flex: "1 1 200px", minWidth: 0 }} maxLength={80} />
          <input className="inp" id="sp-new-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Sign-in email (optional)"
            aria-label="New salesperson's email" type="email" style={{ flex: "1 1 220px", minWidth: 0 }} />
          <button className="btn btn-pri" type="submit" disabled={!name.trim() || busy === "add"}>
            {busy === "add" ? "Adding…" : "+ Add salesperson"}
          </button>
        </form>
      ) : null}

      {people && people.length ? (
        <div className="tbl-wrap">
          <div className="tbl-scroll">
            <table className="acc-tbl">
              <thead>
                <tr><th>Salesperson</th><th>Clients</th><th>Month 1</th><th>Residual</th><th /></tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const edit = editing?.id === p.id ? editing : null;
                  return (
                    <tr key={p.id}>
                      <td>
                        {edit ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <input className="inp" value={edit.name} aria-label="Name" maxLength={80} style={{ flex: "1 1 160px", minWidth: 0 }}
                              onChange={(e) => setEditing({ ...edit, name: e.target.value })} />
                            <input className="inp" value={edit.email} aria-label="Sign-in email" type="email" placeholder="Sign-in email (optional)"
                              style={{ flex: "1 1 200px", minWidth: 0 }} onChange={(e) => setEditing({ ...edit, email: e.target.value })} />
                          </div>
                        ) : (
                          <>
                            <div className="cname" style={{ opacity: p.active ? 1 : 0.55 }}>
                              {p.name}
                              {!p.active ? <span className="csince" style={{ marginLeft: 8 }}>inactive</span> : null}
                            </div>
                            <div className="csince">{p.email ?? "no sign-in — records only"}</div>
                          </>
                        )}
                      </td>
                      <td>{p.clients ?? "—"}</td>
                      <td>{Math.round(p.rates.monthOne * 100)}%</td>
                      <td>
                        <select className="sel" value={p.rates.residual} disabled={busy === p.id}
                          aria-label={`${p.name}'s residual rate`}
                          onChange={(e) => void run(p.id, async () => {
                            await call("PATCH", { id: p.id, residualRate: Number(e.target.value) });
                            return `${p.name}'s residual is now ${Math.round(Number(e.target.value) * 100)}%.`;
                          })}>
                          <option value={0.15}>15%</option>
                          <option value={0.25}>25%</option>
                        </select>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {edit ? (
                          <span style={{ display: "inline-flex", gap: 12 }}>
                            <button type="button" style={LINK} disabled={busy === p.id || !edit.name.trim()} onClick={() => void saveEdit()}>
                              {busy === p.id ? "Saving…" : "Save"}
                            </button>
                            <button type="button" style={{ ...LINK, color: "var(--muted)" }} onClick={() => setEditing(null)}>Cancel</button>
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 12 }}>
                            <button type="button" style={LINK} onClick={() => setEditing({ id: p.id, name: p.name, email: p.email ?? "" })}>Edit</button>
                            <button type="button" style={{ ...LINK, color: p.active ? "var(--red)" : "var(--blue)" }} disabled={busy === p.id}
                              onClick={() => void run(p.id, async () => {
                                await call("PATCH", { id: p.id, active: !p.active });
                                return p.active ? `${p.name} is inactive — out of the picker; their clients keep the name.` : `${p.name} is active again.`;
                              })}>
                              {p.active ? "Deactivate" : "Reactivate"}
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : people && available ? (
        <p style={{ fontSize: 13.5, color: "var(--muted)" }}>No salespeople yet — add the first above.</p>
      ) : null}

      {note ? (
        <p role="status" style={{ fontSize: 13, marginTop: 10, color: note.bad ? "var(--red)" : "var(--muted)" }}>{note.text}</p>
      ) : null}
    </section>
  );
}
