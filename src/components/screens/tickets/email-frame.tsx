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
  const prepared = useMemo(
    () => (origin ? prepareEmail({ html, text, messageId, attachments, showImages, origin }) : null),
    [html, text, messageId, attachments, showImages, origin],
  );
  useEffect(() => { if (prepared) onBlocked?.(prepared.blockedImages); }, [prepared, onBlocked]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !prepared) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      setHeight(Math.max(24, Math.ceil(doc.documentElement.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(body); }
      frame.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
    };
    frame.addEventListener("load", onLoad);
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
