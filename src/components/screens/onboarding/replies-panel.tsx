"use client";

import { useEffect, useState } from "react";

import type { RecentReply } from "@/lib/tools/onboarding/pipeline";
import { fullStamp } from "@/lib/workspace/dates";
import { Btn } from "./toast";

/*
 * Recent client replies — the tool's `components/RepliesPanel.tsx`.
 *
 * Collapsible, and the choice sticks per browser. Nothing here is loaded on
 * demand: the eight rows arrive with the pipeline, so hiding the panel is a
 * matter of taste rather than bandwidth.
 */

const KEY = "corofy.hideReplies";

export function RepliesPanel({ replies }: { replies: RecentReply[] }) {
  // null until storage has been read — rendering "shown" and then flipping to
  // "hidden" on the next frame is the flicker the tool avoids the same way.
  const [hidden, setHidden] = useState<boolean | null>(null);

  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(KEY) === "1";
    } catch {
      // Private mode or blocked storage: the panel simply shows.
    }
    setHidden(stored);
  }, []);

  const toggle = () =>
    setHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Not remembered, still toggled.
      }
      return next;
    });

  if (hidden === null) return null;

  return (
    <div className="tbl-wrap" style={{ marginTop: 16 }}>
      <div className="tbl-head">
        <div>
          <div className="tbl-title">Recent client replies</div>
          <div className="tbl-sub">Client responses to our emails, newest first, across every client.</div>
        </div>
        <Btn onClick={toggle}>{hidden ? "Show" : "Hide"}</Btn>
      </div>

      {!hidden &&
        (replies.length === 0 ? (
          <div style={{ padding: "30px 22px", textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
            No replies yet — client responses to our emails appear here automatically.
          </div>
        ) : (
          <div className="tbl-scroll">
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Client</th>
                  <th>From</th>
                  <th>Subject</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {replies.map((r) => (
                  <tr key={r.id}>
                    <td className="mut nowrap">{fullStamp(r.receivedAt) || "—"}</td>
                    <td className="nowrap">
                      {/* The same way in as the Client column — see pipeline.tsx. */}
                      <a
                        href={`/onboarding/clients/${r.clientId}`}
                        className="cname"
                        style={{ textDecoration: "none", color: "var(--ink)" }}
                      >
                        {r.clientName ?? "—"}
                      </a>
                    </td>
                    <td className="mut cell-ellipsis">{r.fromEmail}</td>
                    <td className="cell-ellipsis" style={{ maxWidth: 260 }}>{r.subject}</td>
                    <td className="mut cell-ellipsis" style={{ maxWidth: 320 }}>{(r.snippet ?? "").slice(0, 90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
