"use client";

import { useMemo, useState } from "react";

import type { Reminder, RemindersData } from "@/lib/tools/master-inbox/reminders";
import { fullStamp } from "@/lib/workspace/dates";
import { Lazy, PlaceholderScreen } from "../lazy";

/*
 * Master Inbox — reminders.
 *
 * Snoozed threads, and when they come back.
 *
 * The screen is explicit that it does not fire them, because in the live tool
 * opening the reminders page is what fires due reminders and returns their
 * threads to the inbox. A workspace screen showing "3 due" while silently
 * doing nothing would look handled, which is worse than not having the screen.
 */

export function RemindersScreen({ initial }: { initial: RemindersData | null }) {
  return (
    <Lazy<RemindersData>
      initial={initial}
      url="/api/tools/master-inbox/reminders"
      label="Reminders"
      skeleton={<PlaceholderScreen cards={2} />}
    >
      {(data) => <RemindersView data={data} />}
    </Lazy>
  );
}

function RemindersView({ data }: { data: RemindersData }) {
  const [search, setSearch] = useState("");
  // The SERVER's clock — "due" must be decided once, not once per side.
  const now = useMemo(() => new Date(data.now).getTime(), [data.now]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.reminders;
    return data.reminders.filter(
      (r) =>
        (r.subject ?? "").toLowerCase().includes(q) ||
        (r.leadName ?? "").toLowerCase().includes(q) ||
        (r.leadEmail ?? "").toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q),
    );
  }, [data.reminders, search]);

  if (data.error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Reminders could not be read.</b> {data.error}
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      {data.dueCount > 0 ? (
        <div className="anno" style={{ marginBottom: 16 }}>
          <b>
            {data.dueCount} reminder{data.dueCount === 1 ? " is" : "s are"} due.
          </b>{" "}
          The workspace does not fire them yet — opening Master Inbox&rsquo;s own
          Reminders page is still what returns those threads to the inbox.
        </div>
      ) : null}

      <div className="cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
        <Card label="Pending" value={data.reminders.length} sub="threads snoozed" />
        <Card
          label="Due Now"
          value={data.dueCount}
          sub="past their time"
          tone={data.dueCount > 0 ? "n-risk" : "n-green"}
        />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Reminders</div>
            <div className="tbl-sub">
              Soonest first
              {rows.length !== data.reminders.length ? ` · showing ${rows.length}` : ""}
            </div>
          </div>
          <input
            className="inp"
            placeholder="Search reminders…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search reminders"
          />
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Thread</th>
                <th>Lead</th>
                <th>Due</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    {search.trim()
                      ? `Nothing matches “${search.trim()}”.`
                      : "No threads are snoozed."}
                  </td>
                </tr>
              ) : (
                rows.map((r) => <Row key={r.id} r={r} now={now} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ r, now }: { r: Reminder; now: number }) {
  return (
    <tr>
      <td><div className="cname">{r.subject ?? "(no subject)"}</div></td>
      <td className="mut">{r.leadName ?? r.leadEmail ?? <span className="api-none">—</span>}</td>
      <td>
        {!r.remindAt ? (
          <span className="api-none">—</span>
        ) : r.due ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {overdue(r.remindAt, now)}
          </span>
        ) : (
          <span className="mut">{fullStamp(r.remindAt)}</span>
        )}
      </td>
      <td className="mut">{r.note ?? <span className="api-none">—</span>}</td>
    </tr>
  );
}

/** How long a due reminder has been waiting — the number that prompts action. */
function overdue(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "due";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `due ${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `due ${hours}h ago`;
  return `due ${Math.floor(hours / 24)}d ago`;
}

function Card({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className={`card-n tnum${tone ? ` ${tone}` : ""}`}>{value.toLocaleString("en-US")}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
