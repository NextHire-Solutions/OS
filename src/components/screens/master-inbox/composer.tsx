"use client";

import { useEffect, useRef, useState } from "react";

import type { ThreadDetail } from "@/lib/tools/master-inbox/inbox-view";
import { ALWAYS_CC_EMAIL, mergeAlwaysCcString } from "@/lib/tools/master-inbox/inbox/auto-cc";

/*
 * The reply composer.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE
 *
 * There is NO send idempotency anywhere in the chain. The stored row converges
 * with the webhook echo through `external_message_id`, but the SEND has no
 * key: calling it twice sends the agent two emails.
 *
 * So every path that could submit twice is closed, not merely discouraged:
 *
 *   the button disables the instant a send starts, before the await;
 *   a ref guards the handler, because React can process two clicks before a
 *   state update lands;
 *   ⌘-Enter goes through the same guard rather than around it;
 *   there is NO retry button on failure. A failed send may have been
 *   delivered — the provider can accept and the response still be lost — so
 *   the honest instruction is "check the thread", not "press it again".
 *
 * That last one is deliberate and will look like a missing feature. It is not.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNATURE IS THE CALLER'S JOB
 *
 * The route sends `body` verbatim and never touches the signature. The tool's
 * own composer appends `outbound_sender_signature` when its toggle is on,
 * default on — so this does the same, here, before the body is sent.
 */

/*
 * Plain text as HTML, the way the tool's rich-text editor produces it.
 *
 * Their composer sends `content_type: "html"` because its editor emits HTML.
 * This one is a textarea, so the newlines have to become markup or the reply
 * arrives as one unbroken paragraph.
 */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The CC list, using the tool's own merge.
 *
 * Drops the auto-CC when that address is already the recipient — replying to a
 * thread where Nicole IS the lead should copy her once, not twice.
 */
function ccList(to: string | null): { email_address: string }[] | undefined {
  const merged = mergeAlwaysCcString("", to);
  const list = merged
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => x.includes("@"))
    .map((email_address) => ({ email_address }));
  return list.length > 0 ? list : undefined;
}

export function Composer({ detail, onSent }: { detail: ThreadDetail; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [addSignature, setAddSignature] = useState(true);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // The state flag alone is not enough: two clicks can be handled before a
  // re-render. This closes that window.
  const inFlight = useRef(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);

  // A different conversation is a different reply.
  useEffect(() => {
    setOpen(false);
    setBody("");
    setFailed(null);
    setSent(false);
  }, [detail.id]);

  const to = detail.lead.email;
  const provider = detail.source_provider;
  const sender = detail.outbound_sender_email;

  async function send() {
    if (inFlight.current || sending) return;
    if (!body.trim()) {
      setFailed("Write something first.");
      return;
    }
    inFlight.current = true;
    setSending(true);
    setFailed(null);

    try {
      /*
       * The body, assembled the way their composer assembles it: HTML, with
       * the signature appended when the toggle is on. The route sends `body`
       * verbatim and never touches the signature — that is the caller's job.
       */
      const html =
        addSignature && detail.outbound_sender_signature
          ? `${toHtml(body)}${detail.outbound_sender_signature}`
          : toHtml(body);

      const res = await fetch(
        `/api/tools/master-inbox/threads/reply?threadId=${encodeURIComponent(detail.id)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          /*
           * The same payload their composer posts, field for field.
           *
           * `subject` is the thread's own, unchanged — which is why
           * `subject_changed` is false. That flag decides which EmailBison
           * endpoint the route uses: /replies/{id}/reply silently DROPS a
           * changed subject, so a changed one has to go through /replies/new,
           * at the cost of starting a new thread on their side.
           *
           * `cc` carries the workspace auto-CC. The server stopped re-adding
           * it in June 2026, so the composer is the only thing that puts it
           * there — omitting it means Nicole silently stops being copied on
           * replies, which is the sort of thing nobody notices for a month.
           *
           * `reply_all` and `inject_previous_email_body` are deliberately
           * absent, exactly as in theirs: the route's defaults (false, true)
           * are the intended behaviour, and sending them would be restating
           * a default that could drift.
           */
          body: JSON.stringify({
            body: html,
            content_type: "html",
            subject: detail.subject ?? "",
            subject_changed: false,
            to: to ? [{ email_address: to, name: detail.lead.full_name ?? undefined }] : undefined,
            cc: ccList(to),
          }),
        },
      );

      const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(parsed?.error ?? `The send failed (${res.status})`);

      setSent(true);
      setBody("");
      setOpen(false);
      onSent();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The send failed");
    } finally {
      setSending(false);
      /*
       * The in-flight guard is released, but the failure branch shows no retry
       * button — see the note at the top. Someone can deliberately re-open and
       * write again, which is a decision rather than a reflex.
       */
      inFlight.current = false;
    }
  }

  if (!to) {
    return (
      <div className="anno" style={{ marginTop: 14 }}>
        <b>No address to reply to.</b> This conversation has no lead email recorded.
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn btn-pri" onClick={() => setOpen(true)}>Reply</button>
        {sent ? (
          <span className="tg" style={{ background: "var(--green-bg)", borderColor: "transparent", color: "var(--green)" }}>
            Sent
          </span>
        ) : null}
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          to {to}
          {provider ? ` · via ${provider === "emailbison" ? "EmailBison" : "Instantly"}` : ""}
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14, padding: 14, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--surface)" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 9 }}>
        To <b>{to}</b>
        {sender ? <> · from <b>{sender}</b></> : null}
        {provider ? <> · {provider === "emailbison" ? "EmailBison" : "Instantly"}</> : null}
        {ccList(to) ? <> · cc <b>{ALWAYS_CC_EMAIL}</b></> : null}
      </div>

      <textarea
        ref={area}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Through the same guard as the button, not around it.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Write your reply…"
        rows={8}
        disabled={sending}
        aria-label="Reply body"
        style={{
          width: "100%",
          padding: "11px 13px",
          borderRadius: 10,
          border: "1px solid var(--line-soft)",
          fontSize: 13.5,
          lineHeight: 1.65,
          fontFamily: "inherit",
          resize: "vertical",
          background: sending ? "var(--inset)" : "var(--surface)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 11, flexWrap: "wrap" }}>
        <button
          className="btn btn-pri"
          onClick={send}
          disabled={sending || !body.trim()}
          style={sending ? { opacity: 0.6, cursor: "progress" } : undefined}
        >
          {sending ? "Sending…" : "Send reply"}
        </button>

        <button className="fp" onClick={() => setOpen(false)} disabled={sending}>Cancel</button>

        {detail.outbound_sender_signature ? (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-2)" }}>
            <input
              type="checkbox"
              checked={addSignature}
              onChange={(e) => setAddSignature(e.target.checked)}
              disabled={sending}
            />
            Add signature
          </label>
        ) : null}

        <span style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: "auto" }}>⌘↵ to send</span>
      </div>

      {failed ? (
        <div className="anno" style={{ marginTop: 11, borderColor: "var(--red)" }}>
          <b>{failed}</b>
          {/*
            No retry button, on purpose. A failed request may still have been
            delivered — the provider can accept the send and the response be
            lost — and there is no idempotency key, so pressing again would
            send a second email to a real person.
          */}
          <div style={{ marginTop: 5, fontSize: 12.5, color: "var(--muted)" }}>
            Check the conversation before writing again — the email may have gone
            out even though this failed. There is no safe automatic retry.
          </div>
        </div>
      ) : null}
    </div>
  );
}
