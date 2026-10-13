"use client";

import { useMemo, useState } from "react";

import { countVariations, htmlToPlainText, rollSpintax } from "@/lib/tools/analytics/spintax.ts";
import { Seg } from "./shared";
import { Btn } from "./toast";

/*
 * The inline email panel shown when a step is expanded — the tool's
 * `components/analytics/email-panel.tsx`.
 *
 *   Preview — spintax rolled, HTML rendered: what one recipient actually gets.
 *   Spintax — the raw source with every group highlighted, so you can see the
 *             choices rather than one sample of them.
 *
 * Shuffle re-rolls with a new seed. The seed lives in state (not a bare
 * Math.random() at render time) so Preview is stable while you read it and
 * only changes when you ask.
 *
 * THE PREVIEW IS AN IFRAME, NOT `dangerouslySetInnerHTML`. The tool injects
 * the body straight into its own document and calls it "the same trust
 * boundary as the sequence editor they were written in" — true there, where
 * the app IS the campaign tool. Here the page is the workspace shell, which
 * holds every other tool's session. A sandboxed iframe with `srcDoc` renders
 * the HTML exactly as a mail client would while giving it no scripts, no
 * same-origin access and no way to submit a form — the markup is displayed,
 * not executed. It is the one deliberate difference from the tool.
 */
export function EmailPanel({ subject, body }: { subject: string | null; body: string | null }) {
  const [view, setView] = useState<"preview" | "spintax">("preview");
  const [seed, setSeed] = useState(1);

  const variations = body ? countVariations(body) : 1;
  const rolled = useMemo(() => (body ? rollSpintax(body, seed) : ""), [body, seed]);

  if (!body) {
    return (
      <div
        style={{
          border: "1px dashed var(--line)", borderRadius: "var(--r-md)", padding: 16,
          textAlign: "center", fontSize: 12.5, color: "var(--muted)",
        }}
      >
        No email body stored for this step.
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", overflow: "hidden", background: "var(--surface)" }}>
      <div
        style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
          padding: "8px 12px", borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <Seg
          label="Email view"
          value={view}
          onChange={setView}
          options={[
            { value: "preview", label: "Preview" },
            { value: "spintax", label: "Spintax" },
          ]}
        />
        {view === "preview" && variations > 1 ? (
          <Btn style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setSeed((s) => s + 1)}>
            Shuffle
          </Btn>
        ) : null}
        {/* The Blueprint side panel (a guessed breakdown of the message into
            parts) was removed on 13 Oct — OS feedback. */}
        <span className="mut" style={{ marginLeft: "auto", fontSize: 11.5 }}>
          {variations > 1 ? `${variations.toLocaleString("en-US")} variations` : "no spintax"}
          {" · "}
          {/* Merge tags are NOT substituted here — they render literally at
              send time, and pretending otherwise would misrepresent the copy. */}
          {"{FIRST_NAME}"} fills in at send time
        </span>
      </div>

      {subject ? (
        <div className="msg-hdrs">
          <span><b>Subj</b> {view === "preview" ? rollSpintax(subject, seed) : subject}</span>
        </div>
      ) : null}

      <div>
        <div style={{ minWidth: 0 }}>
          {view === "preview" ? (
            <iframe
              title={subject ? `Preview — ${subject}` : "Email preview"}
              // No tokens at all: no scripts, no forms, no same-origin, no
              // popups. The body can only be looked at.
              sandbox=""
              srcDoc={previewDocument(rolled)}
              style={{ display: "block", width: "100%", height: 380, border: 0, background: "#fff" }}
            />
          ) : (
            <pre
              style={{
                margin: 0, padding: "14px 16px", fontSize: 12, lineHeight: 1.6,
                fontFamily: "var(--mono)", color: "var(--ink-2)", whiteSpace: "pre-wrap",
                wordBreak: "break-word", maxHeight: 380, overflowY: "auto",
              }}
            >
              {highlightSpintax(htmlToPlainText(body))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The document the iframe shows. A mail client's defaults, roughly: a system
 * face, a readable measure, images capped to the width. Nothing from the
 * workspace's stylesheet reaches in here, which is the point.
 */
function previewDocument(html: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<style>body{margin:0;padding:16px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d2330;word-break:break-word}" +
    "img{max-width:100%;height:auto}a{color:#0165fe}p{margin:0 0 1em}</style></head><body>" +
    html +
    "</body></html>"
  );
}

/** Renders `{a|b}` groups with a tint so the choices are visible at a glance. */
function highlightSpintax(text: string) {
  const parts = text.split(/(\{[^{}]*\|[^{}]*\})/g);
  return parts.map((part, i) =>
    /^\{[^{}]*\|[^{}]*\}$/.test(part) ? (
      <mark
        key={i}
        style={{ background: "var(--blue-pale)", color: "var(--blue-ink)", borderRadius: 4, padding: "0 2px" }}
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
