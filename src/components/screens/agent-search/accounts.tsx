"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { CourtedState } from "@/lib/tools/agent-search/courted-state";
import { mlsDisplayName } from "@/lib/tools/agent-search/format";
import { buildSweepPayload } from "@/lib/tools/agent-search/payload";
import { jobStore } from "./job-store";
import {
  Actions, AgentSearchHeader, Card, Check, Field, Msg, ago, elapsedLabel, pollCourtedState,
  useStatus, type FireReply,
} from "./shared";

/*
 * Courted accounts — add a login, choose what to import, start the sweep.
 *
 * Two halves:
 *
 *   The ADD flow is the tool's, step for step, and it is the most consequential
 *   thing in Agent Search. It validates the login against Courted first, then
 *   writes COURTED_EMAIL_n into the Railway service — which redeploys it. The
 *   UI then polls /api/status until the account count rises, because the sweep
 *   must not be started on a container that is about to restart.
 *
 *   The ACCOUNTS TABLE is new. The tool keeps nine Courted logins in Railway
 *   env vars and its UI shows only how many there are — while its two
 *   schedulers write a full picture into Supabase every day and read it back
 *   to nobody. That is what the table below shows.
 */

/*
 * Wait for the Railway redeploy.
 *
 * Writing COURTED_EMAIL_n restarts the service, so for a minute or two the
 * container is either the OLD one (which does not know the new account) or
 * gone entirely. Starting the sweep in that window would run it on a process
 * about to die.
 *
 * Verbatim timing from app.js `waitForAccounts`: wait 10s before the first
 * poll so the redeploy has begun, then every 5s, and treat a failed request as
 * "still restarting" rather than an error — a refused connection mid-redeploy
 * is the expected case, not a fault.
 */
function waitForAccounts(expected: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      fetch("/api/tools/agent-search/status", { cache: "no-store", credentials: "same-origin" })
        .then((r) => r.json())
        .then((s: { courtedAccounts?: number }) => {
          if ((s.courtedAccounts ?? 0) >= expected) resolve();
          else setTimeout(tick, 5000);
        })
        .catch(() => setTimeout(tick, 5000));
    };
    setTimeout(tick, 10000);
  });
}

interface MlsOption { code: string; name?: string | null; count?: number | null }

export function AgentSearchAccountsScreen() {
  const status = useStatus();
  const job = useSyncExternalStore(jobStore.subscribe, jobStore.getSnapshot, jobStore.getServerSnapshot);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  const [mlsOptions, setMlsOptions] = useState<MlsOption[] | null>(null);
  const [mlsTotal, setMlsTotal] = useState(0);
  const [wholeAccount, setWholeAccount] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [state, setState] = useState<CourtedState | null>(null);
  const loadState = useCallback(() => {
    fetch("/api/tools/agent-search/courted-state", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s: CourtedState) => setState(s))
      .catch(() => {});
  }, []);
  useEffect(loadState, [loadState]);

  const say = (text: string, error = false) => { setMsg(text); setIsError(error); };

  /* ------------------------------------------------------------- detect MLS */

  async function detectMls() {
    if (!email.trim() || !password) { say("Enter the Courted email and password first.", true); return; }
    setDetecting(true);
    say("Signing in and reading this account’s MLSs — a few seconds…");
    try {
      const res = await fetch("/api/tools/agent-search/courted/mls-list", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const d = (await res.json()) as { error?: string; total?: number; mls?: MlsOption[] };
      if (!res.ok || d.error) throw new Error(d.error ?? "request failed");
      setMlsOptions(d.mls ?? []);
      setMlsTotal(d.total ?? 0);
      setWholeAccount(true);
      setPicked(new Set());
      const n = (d.mls ?? []).length;
      say(`Found ${n} MLS${n === 1 ? "" : "s"}. Tick the one(s) to import, or keep “Whole account”.`);
    } catch (e) {
      say("Detect failed: " + (e instanceof Error ? e.message : "unknown error"), true);
    } finally {
      setDetecting(false);
    }
  }

  /*
   * The picker's two halves are mutually exclusive, and it can never end up
   * with nothing selected — unticking the last MLS falls back to the whole
   * account rather than silently meaning "import nothing".
   */
  function toggleMls(code: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      setWholeAccount(next.size === 0);
      return next;
    });
  }
  function chooseWhole() {
    setWholeAccount(true);
    setPicked(new Set());
  }

  /* --------------------------------------------------------- add + sweep */

  async function addAccount() {
    if (!email.trim() || !password) { say("Enter the Courted email and password.", true); return; }
    const codes = wholeAccount ? [] : [...picked];
    setBusy(true);
    say("Validating login & saving the account…");
    try {
      const res = await fetch("/api/tools/agent-search/courted/account", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const d = (await res.json()) as {
        error?: string; already?: boolean; updated?: boolean; slot?: number; accountsExpected?: number;
      };
      if (!res.ok || d.error) throw new Error(d.error ?? "request failed");

      /*
       * Password changed on an existing account. The new password is validated
       * and saved, but Railway is redeploying to apply it — so the sweep must
       * NOT start on the current, about-to-restart instance.
       */
      if (d.already && d.updated) {
        say(`Password updated ✓ for ${email.trim()}. The server is redeploying to apply it (~1–2 min). ` +
            `Once it’s back, click “Add account & start sweep” again to run the sweep.`);
        setPassword("");
        setBusy(false);
        return;
      }

      if (d.already) {
        say("Account already saved (password unchanged) — starting the sweep…");
      } else {
        say(`Saved (account #${d.slot}). Restarting the service to load it — ~1–2 min…`);
        await waitForAccounts(d.accountsExpected ?? 0);
        say("Service is back up. Starting the sweep…");
      }
      await startSweep(email.trim(), codes);
      loadState();
    } catch (e) {
      say("Failed: " + (e instanceof Error ? e.message : "unknown error"), true);
    } finally {
      setBusy(false);
    }
  }

  async function startSweep(sweepEmail: string, codes: string[]) {
    // Built by a pure function, and asserted in the tests rather than fired —
    // a whole-account sweep re-scrapes up to 866,000 agents. See payload.ts.
    const body = buildSweepPayload(sweepEmail, codes);
    const r = await jobStore.start(
      body as unknown as Record<string, unknown>,
      { active: ["courted"], origin: "sweep", sweepEmail },
    );
    if (!r.ok) { say("Sweep failed to start: " + (r.error ?? ""), true); return; }
    setPassword("");
    say(`Sweep started ✓ for ${sweepEmail}${codes.length ? " · MLS " + codes.join(", ") : " · whole account"} — ` +
        `live progress is on the Search screen’s Courted panel.`);
  }

  const sweeping = job.running && job.origin === "sweep";
  const courted = job.sources.courted;

  return (
    <div className="as as-screen">
      <AgentSearchHeader
        title="Courted accounts"
        sub="Each login unlocks its own set of MLSs — add one and every agent it can see is swept in"
        status={status}
      />

      <Card
        title="➕ Add a Courted account"
        sub="Enter a new Courted login. It's saved to the server and its agents are swept into the database automatically — no setup needed. An email already on file is treated as a password update, validated before anything is overwritten."
      >
        <div className="as-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <Field label="Courted email">
            <input className="as-i" type="email" autoComplete="off" placeholder="agent@brokerage.com"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <input className="as-i" type="password" autoComplete="new-password" placeholder="••••••••"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Target MLS" hint="(optional)">
            <button className="as-btn ghost" type="button" onClick={() => void detectMls()} disabled={detecting}
              style={{ width: "100%" }}>
              {detecting ? "Detecting…" : "Detect MLSs"}
            </button>
          </Field>
        </div>

        {mlsOptions ? (
          <div style={{
            marginTop: 16, padding: 16, border: "1px solid var(--line)", borderRadius: 12,
            background: "var(--inset)", display: "grid", gap: 10,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              Choose what to import from this account:
            </div>
            <Check
              checked={wholeAccount}
              onChange={(v) => { if (v) chooseWhole(); }}
              label="Whole account"
              hint={`${mlsTotal.toLocaleString("en-US")} agents — everything`}
            />
            {mlsOptions.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                No individual MLSs detected — import the whole account.
              </div>
            ) : mlsOptions.map((m) => (
              <Check
                key={m.code}
                checked={picked.has(m.code)}
                onChange={() => toggleMls(m.code)}
                label={mlsDisplayName({ code: m.code, name: m.name })}
                hint={`${m.code} · ${(m.count ?? 0).toLocaleString("en-US")} agents`}
              />
            ))}
          </div>
        ) : null}

        <Actions>
          <button className="as-btn" onClick={() => void addAccount()} disabled={busy}
            style={busy ? { opacity: 0.55, cursor: "wait" } : undefined}>
            Add account &amp; start sweep
          </button>
          {sweeping ? (
            <button className="as-btn ghost" style={{ color: "var(--red)" }}
              onClick={() => { jobStore.stop(); say("Sweep stopped. Everything scraped so far is saved — you can re-add to resume."); }}>
              ■ Stop sweep
            </button>
          ) : null}
          {sweeping ? (
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {Math.max(courted.rows.length, courted.serverCount).toLocaleString("en-US")} agents
              {courted.total ? ` / ${courted.total.toLocaleString("en-US")}` : ""} — {courted.message || "running"}
            </span>
          ) : null}
        </Actions>
        <Msg text={msg} tone={isError ? "error" : undefined} />
      </Card>

      <AccountsTable state={state} onRefresh={loadState} />
    </div>
  );
}

/*
 * The nine live accounts.
 *
 * Sorted most-overdue first, which is the order the 15-day refresh scheduler
 * will actually work through — so the top row is the account it does next.
 */
function AccountsTable({ state, onRefresh }: { state: CourtedState | null; onRefresh: () => void }) {
  /*
   * Which rows have a re-scrape in flight, and since when. Per row, not a
   * single flag: the tool never locked anything while a refresh ran — its
   * own handler answers "A refresh is already running" if you ask for a
   * second — so the other buttons stay usable and that message is shown
   * verbatim if it comes.
   */
  const [inflight, setInflight] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [bad, setBad] = useState(false);

  const say = (text: string, error = false) => { setNote(text); setBad(error); };
  const mark = (email: string, on: boolean) =>
    setInflight((cur) => {
      const next = { ...cur };
      if (on) next[email] = Date.now(); else delete next[email];
      return next;
    });

  /*
   * Fire-and-poll. The live handler resolves only when the whole-account
   * sweep is done, hours later, so the workspace route answers 202
   * `{ started }` and the proof of completion is `refresh_state` — the row
   * refresh.js writes when the sweep finishes. Poll courted-state until that
   * account's `lastRefreshedAt` moves past when we pressed the button.
   */
  async function refreshNow(email: string) {
    const before = state?.accounts.find((a) => a.email === email)?.lastRefreshedAt ?? null;
    const t0 = Date.now();
    mark(email, true);
    say(`Starting a re-scrape of ${email}…`);
    try {
      const res = await fetch("/api/tools/agent-search/courted/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const d = (await res.json()) as FireReply & { agents?: number };
      if (!res.ok || d.error) throw new Error(d.error ?? `request failed (${res.status})`);
      // The upstream's own early refusals come back with 200 and ok:false —
      // "A refresh is already running", "No such account".
      if (d.ok === false) throw new Error(d.message ?? "refresh refused");

      if (!d.started) {
        // Finished inside the start window — a tiny account, or a no-op.
        say(`${email}: ${d.message ?? "refresh finished"}${d.agents ? ` · ${d.agents.toLocaleString("en-US")} agents` : ""}`);
        onRefresh();
        return;
      }

      say(`Re-scraping ${email} — a whole-account sweep. Running for under a minute…`);
      const landed = await pollCourtedState(
        (s) => {
          const row = s.accounts.find((a) => a.email === email);
          if (!row?.lastRefreshedAt || row.lastRefreshedAt === before) return false;
          const at = Date.parse(row.lastRefreshedAt);
          // A minute of slack: the service's clock and ours need not agree.
          return Number.isFinite(at) && at >= t0 - 60_000;
        },
        { onTick: (ms) => say(`Re-scraping ${email} — a whole-account sweep. Running for ${elapsedLabel(ms)}…`) },
      );
      if (!landed) {
        say(`${email} is still re-scraping after ${elapsedLabel(Date.now() - t0)} — its result will appear in the table when it finishes.`);
        return;
      }
      const row = landed.accounts.find((a) => a.email === email);
      const ok = row?.lastStatus === "ok";
      say(`${email}: re-scrape ${ok ? "finished" : "failed"}${row?.lastMessage ? ` — ${row.lastMessage}` : ""}`, !ok);
      onRefresh();
    } catch (e) {
      say("Refresh failed: " + (e instanceof Error ? e.message : "unknown error"), true);
    } finally {
      mark(email, false);
    }
  }

  if (state?.error) {
    return (
      <Card title="Configured accounts">
        <Msg text={`Could not read Agent Search's database: ${state.error}`} tone="error" />
      </Card>
    );
  }
  if (!state) return <Card title="Configured accounts" sub="Loading…"><div /></Card>;

  return (
    <Card
      title="Configured accounts"
      small={
        state.configuredAccounts !== null && state.configuredAccounts !== state.accounts.length
          ? `${state.accounts.length} seen · ${state.configuredAccounts} configured`
          : `${state.accounts.length} live`
      }
      sub={`Read from Agent Search's own database — the MLS reach each login has, and where the ${state.refreshWindowDays}-day rolling re-scrape has got to. The tool collects all of this and shows none of it.`}
    >
      {state.configuredAccounts !== null && state.configuredAccounts > state.accounts.length ? (
        <Msg text={
          `${state.configuredAccounts - state.accounts.length} configured account` +
          `${state.configuredAccounts - state.accounts.length === 1 ? " has" : "s have"} not been seen by either scheduler yet. ` +
          "The service keeps its logins in Railway and publishes only a count; an account appears here once the " +
          `${state.refreshWindowDays}-day refresh or the MLS monitor has attempted it.`
        } />
      ) : null}
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 16, fontSize: 13, color: "var(--muted)" }}>
        <span>
          Agent reach{" "}
          <b className="tnum" style={{ color: "var(--ink)" }}>
            {state.reachableAgents?.toLocaleString("en-US") ?? "—"}
          </b>{" "}
          <span style={{ fontSize: 12 }}>(accounts overlap, so this is a ceiling)</span>
        </span>
        <span>Last MLS scan <b style={{ color: "var(--ink)" }}>{ago(state.lastScanAt)}</b></span>
      </div>

      <div className="tbl-scroll">
        <table className="atbl as-acct-tbl" style={{ minWidth: 940 }}>
          <thead>
            <tr>
              <th>Account</th><th>MLSs</th><th style={{ textAlign: "right" }}>Agents</th>
              <th>Last full re-scrape</th><th>Result</th><th />
            </tr>
          </thead>
          <tbody>
            {state.accounts.map((a) => (
              <tr key={a.email}>
                <td className="as-acct-email" style={{ fontWeight: 500, color: "var(--ink)" }}>{a.email}</td>
                <td style={{ maxWidth: 340 }}>
                  <span className="tnum" style={{ color: "var(--ink)" }}>{a.mls.length}</span>
                  <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
                    {a.mls.length ? " · " + a.mls.slice(0, 3).map((m) => m.label).join(", ") : ""}
                    {a.mls.length > 3 ? ` +${a.mls.length - 3}` : ""}
                  </span>
                </td>
                <td className="tnum" style={{ textAlign: "right" }} title={a.scannedAt ? `Last MLS scan ${ago(a.scannedAt)}` : "Not yet scanned by the MLS monitor"}>
                  {a.total?.toLocaleString("en-US") ?? "—"}
                </td>
                <td>
                  <span style={{ color: a.overdue ? "var(--red)" : "var(--ink-2)" }}>{ago(a.lastRefreshedAt)}</span>
                  {a.overdue ? (
                    <span style={{ marginLeft: 7, fontSize: 11.5, color: "var(--red)", fontWeight: 600 }}>overdue</span>
                  ) : null}
                </td>
                <td style={{ color: a.lastStatus === "ok" ? "var(--muted)" : "var(--red)", fontSize: 12.5, maxWidth: 240 }}>
                  {a.lastMessage ?? "—"}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="as-btn ghost" style={{ padding: "7px 12px", fontSize: 12.5 }}
                    disabled={a.email in inflight}
                    onClick={() => void refreshNow(a.email)}
                    title={`Re-scrape every agent ${a.email} can see`}
                  >
                    {a.email in inflight ? "Re-scraping…" : "Re-scrape"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Msg text={note} tone={bad ? "error" : undefined} />
    </Card>
  );
}
