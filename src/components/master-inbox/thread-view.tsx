"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  Mail,
  Archive,
  ArchiveRestore,
  Trash2,
  RotateCcw,
  Reply as ReplyIcon,
  Reply,
  ReplyAll,
  Forward,
} from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Composer } from "@/components/master-inbox/composer";
import { LabelPickerButton } from "@/components/master-inbox/label-picker";
import { SnoozeButton } from "@/components/master-inbox/snooze-button";
import { MoveAgentMenu } from "@/components/master-inbox/move-agent-menu";
import { cn } from "@/lib/tools/master-inbox/utils";
import { sanitizeEmailHtml } from "@/lib/tools/master-inbox/inbox/sanitize-email-html";
import type { ThreadDetail, MessageRow } from "@/lib/tools/master-inbox/inbox/thread-detail";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";

const COLLAPSED_HEIGHT_PX = 140;

function formatTime(ts: string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(name: string | null | undefined, email: string | null | undefined): string {
  const src = name || email || "?";
  return src
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// For inbound messages, decide which display name to show alongside
// the From email. Resolution order:
//
//   1. message.sender_name — the From header's display name captured
//      at sync time (Instantly's from_address_json[0].name, or
//      EmailBison's from_name). The source of truth.
//   2. If sender_name is null AND the sender email matches the lead's
//      email — use the lead's full_name from the prospect row.
//   3. Scan the message body for a "<Name> <<email>>" pattern matching
//      the actual From email (clients quote "On <date>, <Name>
//      <<email>> wrote:" in reply chains). Catches the case where the
//      sync didn't capture sender_name on older rows.
//   4. Fall back to titlecasing the email's local part
//      ("growth@…" → "Growth"). Better than echoing the wrong lead.
function resolveInboundSenderName(
  storedSenderName: string | null,
  senderEmail: string | null,
  leadEmail: string | null,
  leadName: string,
  body: string | null,
): string {
  if (storedSenderName && storedSenderName.trim()) return storedSenderName.trim();
  const a = senderEmail?.trim().toLowerCase() ?? "";
  const b = leadEmail?.trim().toLowerCase() ?? "";
  if (a && b && a === b) return leadName;
  if (!senderEmail) return leadName;
  if (body) {
    const fromBody = displayNameFromBody(body, senderEmail);
    if (fromBody) return fromBody;
  }
  const localPart = senderEmail.split("@")[0] ?? "";
  if (!localPart) return leadName;
  return localPart
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// Pulls a display name out of an HTML or plain-text email body by
// matching the "<Name> <<email>>" pattern most clients emit when
// quoting an earlier message. Case-insensitive email match because
// the same address can be capitalised differently across replies
// ("growth" vs "Growth").
function displayNameFromBody(body: string, senderEmail: string): string | null {
  // Strip tags so HTML and plain text both feed the same regex.
  const text = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  // The leading capture allows letters, digits, common punctuation,
  // and any non-< character so multi-word names with periods or
  // hyphens come through cleanly. The {1,80} cap keeps a malformed
  // body from matching a paragraph of text into the name slot.
  const escaped = senderEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `([A-Za-z][A-Za-z0-9.,'\\- ]{0,80}?)\\s*<\\s*${escaped}\\s*>`,
    "i",
  );
  const match = text.match(re);
  if (!match) return null;
  const candidate = match[1].trim();
  // Reject obvious noise: the candidate must look like a name, not
  // an email scrap or a blob of punctuation.
  if (!candidate || /@/.test(candidate)) return null;
  return candidate;
}

export function ThreadView({
  detail,
  availableLabels = [],
  channels = [],
  prevThreadHref = null,
  nextThreadHref = null,
  backHref = "..",
}: {
  detail: ThreadDetail;
  availableLabels?: LabelRow[];
  // Connected sender mailboxes for this workspace; feeds the composer's
  // From-dropdown so the user can override the thread's pinned sender.
  channels?: Array<{
    id: string;
    provider: "instantly" | "emailbison" | "unipile";
    display_name: string;
    instantly_account_id: string | null;
    email: string | null;
  }>;
  prevThreadHref?: string | null;
  nextThreadHref?: string | null;
  backHref?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // composeState tracks both reply + forward — they share the composer UI
  // but differ in initial To/body. null = composer closed.
  const [composeState, setComposeState] = useState<
    // Reply mode tracks BOTH the source message (per-message icon → that
    // message; bottom button → null = latest inbound) and a replyAll flag
    // that decides how we build the CC list (single message vs entire
    // thread participants).
    | { mode: "reply"; source: MessageRow | null; replyAll: boolean }
    | { mode: "forward"; source: MessageRow }
    | null
  >(null);
  const messages = detail.messages; // already ordered ascending (oldest first)
  const leadName = detail.lead.full_name ?? detail.lead.email ?? "Lead";
  const youName = "You";
  // OUR-side address pinned on the thread from the original webhook
  // (payload.sender_email.email). Always present once the thread has been
  // synced — use it for outbound rows where message.sender wasn't captured.
  const ourSenderEmail = detail.outbound_sender_email;

  async function bulkAction(body: object) {
    const res = await fetch("/api/tools/master-inbox/threads/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  }
  async function markUnread() {
    const ok = await bulkAction({ action: "seen", thread_ids: [detail.id], seen: false });
    if (ok) startTransition(() => router.push(backHref));
  }
  const isArchived = detail.status === "archived";
  const isTrashed = detail.status === "trash";
  async function toggleArchive() {
    const nextStatus = isArchived ? "open" : "archived";
    const ok = await bulkAction({ action: "status", thread_ids: [detail.id], status: nextStatus });
    if (ok) startTransition(() => router.push(backHref));
  }
  async function toggleTrash() {
    if (!isTrashed && !confirm("Move this thread to trash?")) return;
    const nextStatus = isTrashed ? "open" : "trash";
    const ok = await bulkAction({ action: "status", thread_ids: [detail.id], status: nextStatus });
    if (ok) startTransition(() => router.push(backHref));
  }

  return (
    // Top-level layout switched from column→row so the composer can
    // sit as a flex sibling of the messages column instead of
    // overlaying everything (which used to hide the prospect panel
    // on the right whenever a reply was open). Below `lg` the
    // composer falls back to the old fixed overlay — see the wrapper
    // class on the composer container.
    <section className="flex-1 min-w-0 flex bg-background relative">
      <div className="flex-1 min-w-0 flex flex-col">
      {/* Toolbar */}
      <div className="h-10 border-b flex items-center px-3 gap-1">
        <ToolbarIconButton icon={ChevronLeft} label="Back" href={backHref} />
        <ToolbarIconButton
          icon={ChevronUp}
          label="Previous"
          href={prevThreadHref ?? undefined}
          disabled={!prevThreadHref}
        />
        <ToolbarIconButton
          icon={ChevronDown}
          label="Next"
          href={nextThreadHref ?? undefined}
          disabled={!nextThreadHref}
        />
        <div className="flex-1" />
        <ToolbarIconButton
          icon={RefreshCw}
          label="Refresh"
          onClick={() => startTransition(() => router.refresh())}
          disabled={pending}
        />
        <MoveAgentMenu
          threadIds={[detail.id]}
          currentClientId={detail.client_id}
          onMoved={() => startTransition(() => router.refresh())}
          disabled={pending}
        />
        <LabelPickerButton
          threadId={detail.id}
          allLabels={availableLabels}
          assignedLabelIds={detail.labels.map((l) => l.id)}
        />
        <SnoozeButton
          threadId={detail.id}
          backHref={backHref}
          isSnoozed={detail.status === "reminder"}
          disabled={pending}
        />
        <ToolbarIconButton icon={Mail} label="Mark unread" onClick={markUnread} disabled={pending} />
        <ToolbarIconButton
          icon={isArchived ? ArchiveRestore : Archive}
          label={isArchived ? "Move to inbox" : "Archive"}
          onClick={toggleArchive}
          disabled={pending}
        />
        <ToolbarIconButton
          icon={isTrashed ? RotateCcw : Trash2}
          label={isTrashed ? "Restore from trash" : "Delete"}
          onClick={toggleTrash}
          disabled={pending}
        />
      </div>

      {/* Messages — oldest first, newest at bottom. Full pane width so
          inbound cards sit flush left and outbound flush right. */}
      <div className="flex-1 overflow-y-auto">
        <div className="py-6 px-6 space-y-3">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              No messages in this thread yet.
            </p>
          ) : (
            messages.map((m) => (
              <MessageBlock
                key={m.id}
                message={m}
                leadName={leadName}
                leadEmail={detail.lead.email ?? null}
                youName={youName}
                ourSenderEmail={ourSenderEmail}
                onReply={() => setComposeState({ mode: "reply", source: m, replyAll: false })}
                onReplyAll={() => setComposeState({ mode: "reply", source: m, replyAll: true })}
                onForward={() => setComposeState({ mode: "forward", source: m })}
              />
            ))
          )}
        </div>
      </div>

      {/* Floating Reply — shortcut for opening the composer. Hidden
          while the composer is open so it doesn't overlap (and
          intercept clicks on) the composer's own Send button: the
          composer became a flex sibling at lg+ in 2026-05, which put
          this absolute-positioned button right on top of the
          composer footer. */}
      {!composeState ? (
        <Button
          onClick={() => setComposeState({ mode: "reply", source: null, replyAll: false })}
          className="absolute bottom-4 right-4 gap-1.5 shadow-lg z-10"
        >
          <ReplyIcon className="size-4" />
          Reply
        </Button>
      ) : null}
      </div>

      {composeState ? (
        <Composer
          mode={composeState.mode}
          threadId={detail.id}
          signatureHtml={detail.outbound_sender_signature ?? null}
          sourceProvider={detail.source_provider}
          subject={
            composeState.mode === "forward"
              ? `Fwd: ${composeState.source.subject ?? detail.subject ?? ""}`
              : // Reply subject must match the message we're replying to,
                // not the thread's first-ever subject — otherwise on long
                // threads where the subject changed mid-stream (e.g. lead
                // moved into a subsequence with new outreach copy) the
                // outgoing email goes out with the stale original and
                // Gmail breaks threading on the recipient side.
                //
                // Two reply entry points:
                //   - per-message icon → composeState.source is that
                //     specific message; use ITS subject
                //   - floating bottom Reply button → source is null; use
                //     the latest inbound's subject
                ((): string => {
                  const sourceMsg =
                    composeState.source ??
                    [...detail.messages]
                      .reverse()
                      .find((m) => m.direction === "inbound");
                  const base = sourceMsg?.subject ?? detail.subject ?? "";
                  // Normalise to exactly one "Re: " prefix.
                  return /^re:\s/i.test(base) ? base : base ? `Re: ${base}` : "";
                })()
          }
          // Subject is locked in reply mode — forwarding still lets the
          // user edit it (they're starting a new thread with a new
          // recipient, so subject is intentionally fresh).
          subjectLocked={composeState.mode === "reply"}
          {...(() => {
            // Pre-fill TO + CC + BCC based on mode. Reply / Reply All
            // read off the SOURCE message so e.g. replying to Marissa
            // goes back to Marissa, not back to the original campaign
            // lead, and they carry the conversation's CC/BCC forward
            // per the customer's spec.
            if (composeState.mode === "forward") {
              return { toEmail: "", toName: null, ccInitial: "", bccInitial: "" };
            }
            const r = buildReplyRecipients(composeState, detail);
            return {
              toEmail: r.to.email,
              toName: r.to.name,
              ccInitial: r.cc.join(", "),
              bccInitial: r.bcc.join(", "),
            };
          })()}
          sourceMessageId={
            // Per-message Reply / Reply all → that specific message.
            // Bottom Reply button (source: null) → undefined; the API
            // will fall back to the latest inbound.
            composeState.mode === "reply" ? composeState.source?.id ?? null : null
          }
          draft={composeState.mode === "reply" ? detail.pending_draft : null}
          composerDraft={composeState.mode === "reply" ? detail.composer_draft : null}
          // Forward seeds the body with a quoted block of the source message
          // so the user just types their note above it.
          initialBody={composeState.mode === "forward" ? buildForwardBody(composeState.source, detail) : undefined}
          // Keep a separate handle on the forward quote so the composer
          // can re-attach it on send if the user cleared the textarea —
          // empty forward bodies were producing literally empty emails
          // before.
          forwardedBlock={composeState.mode === "forward" ? buildForwardBody(composeState.source, detail) : null}
          fromEmail={
            // Canonical OUR-side address pinned on the thread from the
            // webhook. Falls back to scanning outbound messages only if the
            // thread predates the column.
            detail.outbound_sender_email ??
            [...detail.messages].reverse().find((m) => m.direction === "outbound")?.sender ??
            null
          }
          fromName={detail.channel.display_name ?? null}
          leadCompany={(() => {
            const cf = detail.lead.custom_fields as
              | Record<string, unknown>
              | undefined;
            const v =
              detail.lead.company ??
              (cf?.company as string | undefined) ??
              (cf?.Company as string | undefined) ??
              null;
            return typeof v === "string" && v.trim() ? v : null;
          })()}
          leadTitle={(() => {
            const cf = detail.lead.custom_fields as
              | Record<string, unknown>
              | undefined;
            const v =
              detail.lead.title ??
              (cf?.title as string | undefined) ??
              (cf?.Title as string | undefined) ??
              null;
            return typeof v === "string" && v.trim() ? v : null;
          })()}
          leadPhone={(() => {
            const cf = detail.lead.custom_fields as
              | Record<string, unknown>
              | undefined;
            // Phone lives in a handful of common keys across the
            // Instantly / EmailBison enrichment payloads — pick the
            // first non-empty string. The lead row itself doesn't have
            // a top-level `phone` column today; everything lives in
            // custom_fields.
            const v =
              (cf?.phone as string | undefined) ??
              (cf?.Phone as string | undefined) ??
              (cf?.["phone number"] as string | undefined) ??
              (cf?.phone_number as string | undefined) ??
              (cf?.mobile as string | undefined) ??
              null;
            return typeof v === "string" && v.trim() ? v : null;
          })()}
          channels={channels}
          quoted={(() => {
            if (composeState.mode === "forward") return null;
            const source =
              composeState.source ??
              [...detail.messages].reverse().find((m) => m.direction === "inbound");
            if (!source) return null;
            return {
              sender: detail.lead.full_name ?? detail.lead.email ?? null,
              sent_at: source.sent_at,
              body_text: source.body_text,
              body_html: source.body_html,
            };
          })()}
          onClose={() => setComposeState(null)}
        />
      ) : null}
    </section>
  );
}

function buildForwardBody(source: MessageRow, detail: ThreadDetail): string {
  const sender =
    source.direction === "inbound"
      ? detail.lead.full_name ?? detail.lead.email ?? "Unknown"
      : "You";
  const when = source.sent_at
    ? new Date(source.sent_at).toLocaleString("en-US", { timeZone: "America/New_York" })
    : "";

  // body_text is the preferred source — but it's often stored as an
  // empty string when the sender's mail client only emitted HTML.
  // `??` would let that empty string through and produce an empty
  // forward; check for *non-empty* content explicitly.
  const plainText = source.body_text?.trim();
  let body: string;
  if (plainText && plainText.length > 0) {
    body = plainText;
  } else if (source.body_html && source.body_html.trim().length > 0) {
    // Strip HTML to a readable plain-text fallback. Keep paragraph /
    // line breaks before tag removal so the forwarded message stays
    // readable instead of collapsing to one long line.
    body = source.body_html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    body = "(original message had no body)";
  }

  return [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${sender} <${source.sender ?? ""}>`,
    `Date: ${when}`,
    `Subject: ${source.subject ?? "(no subject)"}`,
    "",
    body,
  ].join("\n");
}

function ccsFromMessage(m: MessageRow): string[] {
  return recipientField(m, "cc");
}

// Generic recipient-list extractor — used for `to`, `cc`, and `bcc`.
// EmailBison + Instantly normalise these to arrays of strings on most
// rows; older rows may have a comma/semicolon-joined string or be
// missing entirely. Tolerates all three.
function recipientField(m: MessageRow, field: "to" | "cc" | "bcc"): string[] {
  const r = (m.recipients ?? {}) as Record<string, unknown>;
  const raw = r[field];
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.includes("@"));
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
  }
  return [];
}

function toAddrsFromMessage(m: MessageRow): string[] {
  return recipientField(m, "to");
}

function bccsFromMessage(m: MessageRow): string[] {
  return recipientField(m, "bcc");
}

// Resolves the TO + CC + BCC the composer should pre-fill for a
// Reply or Reply All against the source message.
//
// Reply (replyAll=false):
//   - TO  = source's sender (for inbound) or first non-us recipient
//           (for outbound), so a Reply on Marissa's direct message
//           goes back to Marissa, not to the original campaign lead.
//   - CC  = the source's own CC list (minus us, minus TO). Operators
//           explicitly asked to keep the existing CCs in the loop on
//           a plain Reply — different from Gmail's default empty.
//   - BCC = the source's own BCC list (minus us, minus TO). Inbound
//           BCC is almost always empty in practice; outbound BCC
//           round-trips through here.
//
// Reply All (replyAll=true):
//   - TO  = same as Reply
//   - CC  = union of every message's CC across the entire thread
//           (minus us, minus TO). Per the customer's spec: "all the
//           cc and bcc email address of the conversation".
//   - BCC = union of every message's BCC across the entire thread
//           (minus us, minus TO).
//
// Both fall back to the latest inbound message (or the lead itself
// as last resort) when state.source is null — that's the bottom
// Reply shortcut button case.
interface ReplyRecipients {
  to: { email: string; name: string | null };
  cc: string[];
  bcc: string[];
}
function buildReplyRecipients(
  state: { mode: "reply"; source: MessageRow | null; replyAll: boolean },
  detail: ThreadDetail,
): ReplyRecipients {
  const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const ourAddr = lower(detail.outbound_sender_email);

  const source =
    state.source ??
    [...detail.messages].reverse().find((m) => m.direction === "inbound") ??
    null;

  // TO resolution. Inbound → sender. Outbound → first non-us recipient.
  // Fall back to the lead when neither yields anything.
  let toEmail: string;
  let toName: string | null = null;
  if (source) {
    if (source.direction === "inbound") {
      toEmail = source.sender ?? detail.lead.email ?? "";
    } else {
      const firstNonUs = toAddrsFromMessage(source).find(
        (a) => lower(a) !== ourAddr,
      );
      toEmail = firstNonUs ?? detail.lead.email ?? "";
    }
    if (lower(toEmail) === lower(detail.lead.email)) {
      toName = detail.lead.full_name ?? null;
    }
  } else {
    toEmail = detail.lead.email ?? "";
    toName = detail.lead.full_name ?? null;
  }

  const toLower = lower(toEmail);
  const exclude = new Set([toLower, ourAddr].filter(Boolean));

  // Collector that preserves first-seen order, drops duplicates, and
  // excludes anyone already in the exclude set (us + TO).
  const buildList = (sources: Array<string[]>): string[] => {
    const seen = new Set<string>(exclude);
    const out: string[] = [];
    for (const list of sources) {
      for (const addr of list) {
        const l = lower(addr);
        if (!l || !l.includes("@") || seen.has(l)) continue;
        seen.add(l);
        out.push((addr ?? "").trim());
      }
    }
    return out;
  };

  let cc: string[] = [];
  let bcc: string[] = [];
  if (state.replyAll) {
    // Walk every message in the thread.
    cc = buildList(detail.messages.map((m) => ccsFromMessage(m)));
    bcc = buildList(detail.messages.map((m) => bccsFromMessage(m)));
  } else if (source) {
    // Plain Reply — carry the source's own CC + BCC forward.
    cc = buildList([ccsFromMessage(source)]);
    bcc = buildList([bccsFromMessage(source)]);
  }

  return { to: { email: toEmail, name: toName }, cc, bcc };
}

function ToolbarIconButton({
  icon: Icon,
  label,
  href,
  onClick,
  disabled = false,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const className = cn(
    "size-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
    disabled && "opacity-40 pointer-events-none",
  );
  if (href) {
    return (
      <a href={href} className={className} aria-label={label} title={label}>
        <Icon className="size-[15px]" strokeWidth={2} />
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={className}
      aria-label={label}
    >
      <Icon className="size-[15px]" strokeWidth={2} />
    </button>
  );
}

function MessageBlock({
  message,
  leadName,
  leadEmail,
  youName,
  ourSenderEmail,
  onReply,
  onReplyAll,
  onForward,
}: {
  message: MessageRow;
  leadName: string;
  leadEmail: string | null;
  youName: string;
  ourSenderEmail: string | null;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
}) {
  const outbound = message.direction === "outbound";
  const [expanded, setExpanded] = useState(false);
  // For outbound: use the row's sender if captured, else fall back to the
  // workspace's pinned OUR-side address (set from the webhook). For inbound:
  // use sender (lead's actual from) or fall back to the lead's email.
  const senderEmail = outbound
    ? message.sender ?? ourSenderEmail
    : message.sender ?? leadEmail;
  // Display name resolution. Outbound is "You". Inbound only borrows
  // the lead's name when the message actually came from the lead's
  // email; otherwise we titlecase the local-part of the From address
  // so multi-participant threads (e.g. the brokerage's own alias
  // replying into the same thread) don't show the lead's name on the
  // wrong message.
  const senderLabel = outbound
    ? youName
    : resolveInboundSenderName(
        message.sender_name,
        senderEmail,
        leadEmail,
        leadName,
        message.body_html ?? message.body_text ?? null,
      );
  const senderInitials = initials(senderLabel, senderEmail);

  return (
    <div
      className={cn(
        // Direction-based alignment: outbound right, inbound left, max ~85% width
        "max-w-[88%]",
        outbound ? "ml-auto" : "mr-auto",
      )}
    >
      {/* Sender header */}
      <div
        className={cn(
          "flex items-center gap-2 text-xs pb-1.5",
          outbound ? "justify-end" : "justify-start",
        )}
      >
        {!outbound ? (
          <Avatar initials={senderInitials} className="bg-emerald-100 text-emerald-800" />
        ) : null}
        {senderEmail ? (
          <span className="text-muted-foreground">({senderEmail})</span>
        ) : null}
        <span className="font-medium text-foreground">{senderLabel}</span>
        {outbound ? <Avatar initials={senderInitials} className="bg-blue-500 text-white" /> : null}
      </div>

      {/* Message card */}
      <div
        className={cn(
          "rounded-xl border bg-card overflow-hidden",
          // Inbound cards have a subtle green tint to differentiate lead replies
          !outbound && "border-emerald-200/80 bg-emerald-50/30",
        )}
      >
        {/* Card header */}
        <div
          className={cn(
            "flex items-center justify-between px-4 py-2.5 border-b",
            !outbound && "border-emerald-200/60",
          )}
        >
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">
              {message.subject || "(no subject)"}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatTime(message.sent_at)}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0 text-muted-foreground">
            {/* Action icons only make sense on lead replies. On our own
                outbound sends, replying to ourselves is meaningless. */}
            {!outbound ? (
              <>
                <CardIcon icon={Reply} label="Reply" onClick={onReply} />
                <CardIcon icon={ReplyAll} label="Reply all" onClick={onReplyAll} />
                <CardIcon icon={Forward} label="Forward" onClick={onForward} />
              </>
            ) : null}
          </div>
        </div>

        {/* Email-style header — From / To / Cc — so operators can see
            every recipient on a message without having to open Reply
            All to inspect them. Hidden when no recipient data is
            available (e.g. older messages synced before recipients
            were captured). */}
        <MessageHeaders
          message={message}
          senderLabel={senderLabel}
          senderEmail={senderEmail}
          outbound={outbound}
        />

        {/* Body with collapse/expand */}
        <div className="relative">
          <div
            className="px-4 py-3 text-sm leading-relaxed overflow-hidden transition-[max-height] duration-150"
            style={{
              maxHeight: expanded ? "none" : `${COLLAPSED_HEIGHT_PX}px`,
            }}
          >
            {message.body_html ? (
              <div
                // `!` on the anchor colour/underline so they beat the
                // global a:link/a:visited { color: inherit } reset in
                // app/globals.css. Brand blue #1565C0 matches the
                // composer + portal accent.
                className="prose prose-sm max-w-none [&_a]:!text-[#1565C0] [&_a]:!underline [&_img]:max-w-full"
                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(message.body_html) }}
              />
            ) : (
              <pre className="whitespace-pre-wrap font-sans">{message.body_text ?? ""}</pre>
            )}
          </div>
          {!expanded ? (
            <div
              className={cn(
                "absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent pointer-events-none",
                outbound ? "from-card" : "from-emerald-50/80",
              )}
            />
          ) : null}
        </div>

        {/* Expand chevron */}
        <div className="flex justify-center border-t py-0.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function CardIcon({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="size-7 rounded-md flex items-center justify-center hover:bg-accent hover:text-foreground transition-colors"
      aria-label={label}
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  );
}

function MessageHeaders({
  message,
  senderLabel,
  senderEmail,
  outbound,
}: {
  message: MessageRow;
  senderLabel: string;
  senderEmail: string | null;
  outbound: boolean;
}) {
  const toAddrs = toAddrsFromMessage(message);
  const ccAddrs = ccsFromMessage(message);
  // Nothing useful → render nothing rather than an empty row.
  if (!senderEmail && toAddrs.length === 0 && ccAddrs.length === 0) return null;
  return (
    <div
      className={cn(
        "px-4 py-2 text-[11.5px] text-muted-foreground space-y-0.5 border-b",
        !outbound && "border-emerald-200/60",
      )}
    >
      {senderEmail ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground/80 w-7 shrink-0">
            From
          </span>
          <span className="break-all">
            {senderLabel}
            {senderEmail ? ` <${senderEmail}>` : ""}
          </span>
        </div>
      ) : null}
      {toAddrs.length > 0 ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground/80 w-7 shrink-0">
            To
          </span>
          <span className="break-all">{toAddrs.join(", ")}</span>
        </div>
      ) : null}
      {ccAddrs.length > 0 ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground/80 w-7 shrink-0">
            Cc
          </span>
          <span className="break-all">{ccAddrs.join(", ")}</span>
        </div>
      ) : null}
    </div>
  );
}

// Strip <style>, <script>, and <link rel="stylesheet"> from inbound
// email HTML before we inject it via dangerouslySetInnerHTML.
//
// Marketing emails routinely ship a `<style>` block that targets the
// `a` selector unscoped — when that gets dropped into the document
// it applies to EVERY anchor on the page, including our sidebar
// links. (The customer's "everything blue and underlined" report
// turned out to be exactly this — opening a thread whose body
// contained `<style>a { color: blue; text-decoration: underline; }
// </style>` re-styled the whole UI.) Stripping these tags keeps the
// content readable while preventing email styles from leaking into
// our app's chrome. Script tags don't execute via dangerouslySet-
// InnerHTML but we strip them too as belt-and-braces.
//
// We're NOT trying to fully sanitize email HTML here — the body
// still ships inline styles, classnames, etc. that affect ONLY the
// content within the prose container. The point is to scope the
// styles to the message, which `<style>` blocks fundamentally
// can't be. (Moved to lib/inbox/sanitize-email-html.ts so the
// portal's read-only conversation sheet can share the same pass.)

function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        "size-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0",
        className,
      )}
    >
      {initials}
    </span>
  );
}
