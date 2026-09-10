"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X, Mail } from "lucide-react";
import { Sheet, SheetContent } from "@/components/mi-ui/sheet";
import { sanitizeEmailHtml } from "@/lib/tools/master-inbox/inbox/sanitize-email-html";
import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { Avatar } from "@/components/master-inbox/portals-ui/portal-ui";
import { cn } from "@/lib/tools/master-inbox/utils";

// Resizable conversation sheet — drag the handle on the left edge to
// widen or narrow. Default is comfy email-reading width; the user's
// chosen width persists across sessions via localStorage. Hard limits
// stop it from shrinking past the point where bubble layout breaks
// or growing past the viewport.
const SHEET_WIDTH_KEY = "portal-conversation-sheet-width";
const DEFAULT_WIDTH = 880;
const MIN_WIDTH = 480;
const MAX_WIDTH = 1400;

// Right-side slide-out conversation viewer. Read-only — clients see
// the email back-and-forth on a candidate's thread without any of
// the staff inbox's reply / label / attachment surface.
//
// Layout decisions:
//  • Inbound (lead's reply) on the LEFT, light-gray bubble.
//  • Outbound (our team) on the RIGHT, soft blue bubble.
//  • Messages ordered oldest → newest so a fresh reader can scroll
//    forward through the thread the same way it landed.
//  • HTML run through sanitizeEmailHtml to strip <style>/<script>/
//    stylesheet <link> blocks that would otherwise leak into the
//    page. The body itself renders inside a `.prose` wrapper which
//    handles every remaining layout tag safely.
//  • Sender name resolves from messages.sender_name (captured at
//    sync time) and falls back to the local-part of the email or
//    "Lead" / "Your team" generic labels.

type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  sender_name: string | null;
  recipients: Record<string, unknown> | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string | null;
};

export function ConversationSheet({
  token,
  entry,
  onClose,
}: {
  token: string;
  entry: PipelineEntry;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Persisted resizable width. Initialised to the default on the
  // server so the SSR/CSR markup matches; localStorage restore runs
  // in a useEffect below.
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(SHEET_WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
        setWidth(saved);
      }
    } catch {
      // localStorage can throw in private-mode Safari — fall back to default.
    }
  }, []);

  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function handleResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    // Sheet enters from the RIGHT, so dragging the left edge LEFTWARD
    // (clientX decreasing) widens the sheet. delta = how far the
    // pointer moved left of where the drag started.
    const delta = dragRef.current.startX - e.clientX;
    const proposed = dragRef.current.startWidth + delta;
    const cap = Math.min(MAX_WIDTH, window.innerWidth - 32);
    setWidth(Math.max(MIN_WIDTH, Math.min(cap, proposed)));
  }
  function handleResizePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setResizing(false);
    try {
      window.localStorage.setItem(SHEET_WIDTH_KEY, String(width));
    } catch {
      // ignore — width still applies for the rest of this session.
    }
  }
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [noThread, setNoThread] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/tools/master-inbox/portal/${token}/conversation/${entry.id}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) {
          setError(j?.error ?? "Couldn't load conversation");
          setLoading(false);
          return;
        }
        if (j.reason === "no_thread") setNoThread(true);
        setMessages(Array.isArray(j.messages) ? j.messages : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, entry.id]);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        // Width is user-resizable via the drag handle on the left
        // edge below. SSR / first paint use DEFAULT_WIDTH; the
        // localStorage restore kicks in on mount. Full-bleed on
        // narrow viewports where the inline width would exceed the
        // screen — Tailwind's responsive `sm:` keeps the cap off
        // mobile.
        className={cn(
          "flex w-full flex-col gap-0 bg-[#fafbfc] p-0",
          resizing ? "transition-none select-none" : "transition-[max-width]",
        )}
        style={{ maxWidth: `min(${width}px, 100vw)` }}
        showCloseButton={false}
      >
        {/* Drag handle on the LEFT edge of the slide-out. Wider hit
            area (6 px) than visual width (1 px line on hover). Hidden
            on touch / sub-md viewports where drag doesn't make
            sense. */}
        <div
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          role="separator"
          aria-label="Drag to resize conversation"
          aria-orientation="vertical"
          className={cn(
            "group absolute inset-y-0 left-0 z-30 hidden w-1.5 cursor-col-resize touch-none md:block",
            resizing && "bg-[#1565C0]/30",
          )}
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-px bg-transparent transition-colors",
              "group-hover:bg-[#bcd5f1]",
              resizing && "bg-[#1565C0]",
            )}
          />
        </div>
        <header className="relative shrink-0 border-b border-[#ebecf0] bg-white px-5 pt-5 pb-4">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md border border-[#ebecf0] bg-white text-[#5b6472] hover:bg-[#f6f7f9]"
          >
            <X className="size-4" />
          </button>
          <div className="flex items-center gap-3 pr-10">
            <Avatar
              name={entry.lead_name ?? entry.lead_email ?? "?"}
              className="size-12 text-[15px]"
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-semibold leading-tight text-[#0f1320]">
                {entry.lead_name || entry.lead_email || "Unknown"}
              </h2>
              {entry.lead_email ? (
                <div className="mt-0.5 truncate text-[12.5px] text-[#5b6472]">
                  {entry.lead_email}
                </div>
              ) : null}
              <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-[#9aa0ab]">
                Conversation
              </div>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-[12.5px] text-[#9aa0ab]">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading conversation…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-[#fcd9d9] bg-[#fff5f5] px-3 py-3 text-[12.5px] text-[#b91c1c]">
              {error}
            </div>
          ) : noThread ? (
            <EmptyState
              title="No conversation yet"
              body="This candidate was added manually — there's no email thread linked to them yet. When a reply comes in, it'll show up here."
            />
          ) : messages.length === 0 ? (
            <EmptyState
              title="Conversation is empty"
              body="No messages have been recorded on this candidate's thread yet."
            />
          ) : (
            <ol className="space-y-4">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  leadName={entry.lead_name ?? entry.lead_email}
                />
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#dde0e5] bg-white p-10 text-center">
      <div className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-[#eef2f7] text-[#5b6472]">
        <Mail className="size-5" />
      </div>
      <p className="mt-3 text-[13.5px] font-medium text-[#0f1320]">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-[#9aa0ab]">
        {body}
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  leadName,
}: {
  message: ConversationMessage;
  leadName: string | null;
}) {
  const isInbound = message.direction === "inbound";
  const senderLabel = isInbound
    ? message.sender_name ||
      leadName ||
      titlecaseLocalPart(message.sender) ||
      "Lead"
    : message.sender_name || "Your team";
  const ts = formatTs(message.sent_at);
  const html = message.body_html ? sanitizeEmailHtml(message.body_html) : null;
  return (
    <li
      className={cn(
        "flex w-full",
        isInbound ? "justify-start" : "justify-end",
      )}
    >
      <div
        className={cn(
          // Wider bubble (max 86 %) + comfier padding so a typical
          // email body lays out in 50-60 chars per line. Email-style
          // reading proportions, not chat-style narrow columns.
          "max-w-[86%] min-w-0 rounded-2xl px-5 py-4 shadow-sm",
          isInbound
            ? "border border-[#ebecf0] bg-white text-[#0f1320]"
            : "border border-[#bcd5f1] bg-[#eaf2fd] text-[#0f1320]",
        )}
      >
        <div className="mb-2 flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="truncate font-semibold text-[#0f1320]">{senderLabel}</span>
          {ts ? (
            <span className="shrink-0 tabular-nums text-[#9aa0ab]">{ts}</span>
          ) : null}
        </div>
        {message.subject ? (
          <div className="mb-2 truncate text-[12px] font-medium text-[#5b6472]">
            {message.subject}
          </div>
        ) : null}
        {html ? (
          <div
            className="prose prose-sm max-w-none text-[13.5px] leading-[1.65] [&_a]:text-[#1565C0] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[#dde0e5] [&_blockquote]:pl-3 [&_blockquote]:text-[#9aa0ab] [&_img]:max-w-full [&_p]:my-2"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-[1.65]">
            {message.body_text ?? ""}
          </pre>
        )}
      </div>
    </li>
  );
}

function titlecaseLocalPart(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return null;
  return email
    .slice(0, at)
    .split(/[._-]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
