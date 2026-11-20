"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { prepareEmail } from "@/lib/tools/tickets/email-html";
import type { Attachment } from "@/lib/tools/tickets/gmail-message";

/*
 * One email's body in a sandboxed frame: no scripts can run (no allow-scripts), links open in a new tab, the
 * frame's own policy blocks remote images until "Show images". Same-origin only so the frame can be measured and
 * grow to its content; with scripts off that gives the email nothing.
 */
export function EmailFrame({ html, text, messageId, attachments, showImages, onBlocked }: {
  html: string | null; text: string | null; messageId: string; attachments: readonly Attachment[]; showImages: boolean;
  onBlocked?: (n: number) => void;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(60);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  // Keyed on what the email IS, not on the array a refresh hands down (a new array every 15 s re-built the frame's
  // content and dropped its size watcher, so opening "•••" stopped growing it — review, 20 Nov).
  const attKey = attachments.map((a) => `${a.partId}:${a.cid ?? ""}`).join("|");
  const attRef = useRef(attachments);
  attRef.current = attachments;
  const prepared = useMemo(
    () => (origin ? prepareEmail({ html, text, messageId, attachments: attRef.current, showImages, origin }) : null),
    [html, text, messageId, attKey, showImages, origin],
  );
  useEffect(() => { if (prepared) onBlocked?.(prepared.blockedImages); }, [prepared, onBlocked]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !prepared) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      // The email's own height (its body), not the document's: that is never shorter than the frame itself, so a
      // one-line email kept the frame's first 60px and left a gap under it (21 Nov).
      const body = doc.body;
      setHeight(Math.max(24, Math.ceil(body ? Math.max(body.scrollHeight, body.getBoundingClientRect().height) : doc.documentElement.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      ro?.disconnect();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(body); }
      frame.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
    };
    frame.addEventListener("load", onLoad);
    // Already loaded (the same content kept): watch it now rather than waiting for a load that won't come.
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.body?.childNodes.length) onLoad();
    return () => { frame.removeEventListener("load", onLoad); ro?.disconnect(); };
  }, [prepared]);

  if (!prepared) return <div style={{ height: 40 }} />;
  return (
    <iframe
      ref={ref}
      className="tk-frame"
      title="Email"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={prepared.doc}
      style={{ height }}
    />
  );
}
