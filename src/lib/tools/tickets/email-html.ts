import { sanitizeEmailHtml } from "@/lib/inbox/sanitize-email-html";

import type { Attachment } from "./gmail-message";

/*
 * TICKETS — an email's HTML, ready for a sandboxed frame. Runs in the browser (DOMParser).
 *
 *  - Sanitised by the Master Inbox's allow-list (scripts, forms, iframes and handlers gone; links open in a tab).
 *  - REMOTE IMAGES BLOCKED until someone presses Show images: a client's tracking pixel would otherwise tell them
 *    every time a teammate opened the ticket (research, 20 Nov). The frame's own Content-Security-Policy blocks
 *    them too, so nothing the sanitiser misses can load.
 *  - The email's own pictures (cid:) come through /api/tools/tickets/attachment — from Gmail, not the sender.
 *  - Quoted history (Gmail, Outlook, Apple Mail, Yahoo) folds behind "•••", as Gmail shows it.
 * The frame is sandboxed without scripts: nothing in an email can run, whatever it contains.
 */

export interface PreparedEmail { doc: string; blockedImages: number }

const QUOTE_SELECTORS = [
  ".gmail_quote", "blockquote[type=cite]", ".yahoo_quoted", "#divRplyFwdMsg", "#appendonsend", ".OutlookMessageHeader",
  "div[style*='border-top:solid #E1E1E1']", "div[style*='border-top: solid #E1E1E1']", "div[style*='border-top:solid #B5C4DF']",
];

const BASE_CSS = `
:root{color-scheme:light}
html,body{margin:0;padding:0;background:transparent}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#0a4fc2}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d6dae0;color:#5f6b7c}
details.tkq{margin:.6em 0 0}
details.tkq>summary{display:inline-flex;align-items:center;justify-content:center;width:30px;height:16px;border-radius:8px;background:#eef0f3;color:#5f6b7c;font:700 11px/1 sans-serif;letter-spacing:1px;cursor:pointer;list-style:none;user-select:none}
details.tkq>summary::-webkit-details-marker{display:none}
details.tkq>summary:hover{background:#e3e6ea}
details.tkq[open]>summary{margin-bottom:.6em}
.tk-blocked{display:inline-block;padding:1px 8px;margin:2px 0;border:1px dashed #d6dae0;border-radius:4px;background:#f6f7f9;color:#8a919c;font:12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap}
`;

/**
 * The frame's policy: nothing runs; images only from the email itself — through the attachment route and nothing
 * else of the OS (review, 20 Nov: a relative <img src="/…"> would otherwise call the OS with the viewer's cookies) —
 * and the web once allowed.
 */
export function frameCsp(origin: string, showImages: boolean): string {
  return [
    "default-src 'none'",
    `img-src data: ${origin}/api/tools/tickets/attachment${showImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    `font-src data:${showImages ? " https:" : ""}`,
  ].join("; ");
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Plain-text email → HTML: links made clickable, the quoted tail ("On … wrote:", "> " lines) folded. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{4,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+/.test(l) && i > 0 && /^\s*$/.test(lines[i - 1] ?? "") && /^(Sent|Date): /.test(lines[i + 1] ?? "")) { cut = i; break; }
    if (/^>/.test(l) && lines.slice(i).every((x) => /^>|^\s*$/.test(x))) { cut = i; break; }
  }
  const link = (s: string) => escapeHtml(s).replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  const head = lines.slice(0, cut).join("\n").replace(/\n+$/, "");
  const tail = lines.slice(cut).join("\n");
  return `<div style="white-space:pre-wrap">${link(head)}</div>${tail.trim() ? `<details class="tkq"><summary title="Show quoted text">•••</summary><div style="white-space:pre-wrap;color:#5f6b7c">${link(tail)}</div></details>` : ""}`;
}

/** The whole document for the frame. Without a DOM (server render) it falls back to the escaped text. */
export function prepareEmail(opts: { html: string | null; text: string | null; messageId: string; attachments: readonly Attachment[]; showImages: boolean; origin: string }): PreparedEmail {
  let bodyHtml: string;
  let blocked = 0;
  if (opts.html && typeof DOMParser !== "undefined") {
    const clean = sanitizeEmailHtml(opts.html);
    const d = new DOMParser().parseFromString(`<div id="tkroot">${clean}</div>`, "text/html");
    const root = d.getElementById("tkroot")!;
    const cid = new Map(opts.attachments.filter((a) => a.cid).map((a) => [a.cid!.toLowerCase(), a.partId]));
    // A picture that won't be shown becomes a quiet chip with its name, never the browser's broken-image icon;
    // a tracking pixel (1×1, 2×2) isn't even that.
    const hide = (img: HTMLImageElement, title: string) => {
      const w = Number(img.getAttribute("width"));
      const h = Number(img.getAttribute("height"));
      if (w <= 2 && h <= 2 && (w || h)) { img.remove(); return; }
      const chip = d.createElement("span");
      chip.className = "tk-blocked";
      chip.setAttribute("title", title);
      chip.textContent = (img.getAttribute("alt") ?? "").trim().slice(0, 40) || "Picture";
      img.replaceWith(chip);
    };
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const src = (img.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        const part = cid.get(src.slice(4).replace(/^<|>$/g, "").toLowerCase());
        if (part) img.setAttribute("src", `${opts.origin}/api/tools/tickets/attachment?m=${encodeURIComponent(opts.messageId)}&p=${encodeURIComponent(part)}&inline=1`);
        else hide(img, "Picture not included in this email");
      } else if (/^https?:\/\//i.test(src)) {
        if (!opts.showImages) { hide(img, "Picture hidden. Show pictures to see it."); blocked++; }
      } else if (!/^data:image\//i.test(src)) {
        // Relative, protocol-relative or anything else: never fetched.
        hide(img, "Picture can't be shown");
      }
    }
    if (!opts.showImages) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style*='url(']"))) {
        el.setAttribute("style", (el.getAttribute("style") ?? "").replace(/url\(\s*['"]?https?:[^)]*\)/gi, "none"));
      }
      for (const el of Array.from(root.querySelectorAll("[background]"))) { el.removeAttribute("background"); blocked++; }
    }
    // Fold quoted history: the first quote block and everything after it at the same level.
    const quote = QUOTE_SELECTORS.map((s) => root.querySelector(s)).filter((x): x is Element => !!x)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
    if (quote && quote !== root && root.textContent && (quote.textContent ?? "").length < root.textContent.length) {
      const details = d.createElement("details");
      details.className = "tkq";
      const summary = d.createElement("summary");
      summary.textContent = "•••";
      summary.setAttribute("title", "Show quoted text");
      details.appendChild(summary);
      const parent = quote.parentNode!;
      parent.insertBefore(details, quote);
      let n: ChildNode | null = quote;
      while (n) { const next: ChildNode | null = n.nextSibling; details.appendChild(n); n = next; }
    }
    bodyHtml = root.innerHTML;
  } else {
    bodyHtml = textToHtml(opts.text ?? "");
  }
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(opts.origin, opts.showImages)}"><base target="_blank"><style>${BASE_CSS}</style></head><body>${bodyHtml}</body></html>`;
  return { doc, blockedImages: blocked };
}
