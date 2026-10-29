/*
 * Plain text → HTML, preserving paragraph and line breaks.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER NEEDS THIS TOO
 *
 * The composer already does this conversion in the browser and always sends
 * `content_type: "html"`, which is why replies typed in the UI arrive looking
 * the way they were written.
 *
 * A reply sent with `content_type: "text"` had no such step. It reached
 * Instantly as a text body, and what landed in the mailbox was every line run
 * together: a 40-paragraph message arrived as one unbroken wall of text, and a
 * short one lost the blank line before its second paragraph.
 *
 * The part worth remembering is how it was missed. The stored row looked
 * perfect — `body_text` held all 80 newlines and all 40 paragraph breaks — so
 * checking the database said the send was fine. Only the rendered email showed
 * the truth. Storage is not rendering.
 *
 * Kept as its own module rather than exported from the composer because the
 * composer is a client component, and pulling it into a route handler would
 * drag the editor in with it.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // `&#039;`, not `&#39;`: the composer writes the four-digit form, and the
    // agent's send is byte-compared against the composer's output.
    .replace(/'/g, "&#039;");
}

/**
 * Single newlines become `<br>`; blank lines become paragraph breaks.
 *
 * Deliberately the same rule as the composer's own `plainTextToHtml`, so a
 * reply sent through the API and one typed in the UI arrive looking identical.
 */
export function plainTextToHtml(s: string): string {
  if (!s) return "";
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}

const BARE_P = /<p>([\s\S]*?)<\/p>/g;
const isBlank = (inner: string) => inner.replace(/<br\s*\/?>/gi, "").replace(/&nbsp;|\s/g, "") === "";

/**
 * Paragraphs the way every mail app shows them (29 Oct).
 *
 * The composer writes each paragraph as a bare `<p>`, and a blank line the person added as an empty `<p></p>`. In Gmail
 * both arrived with no space at all: every paragraph run together, and the added blank lines gone — an empty paragraph
 * has no height, and a bare `<p>` gets no margin there. Same as the first lesson above: the stored row looked fine; only
 * the received email showed it.
 *
 * So a run of bare paragraphs is sent the way Gmail's own composer writes: one `<div>` per paragraph and a blank line
 * (`<div><br></div>`) between paragraphs; an empty paragraph the person added is a blank line of its own — as the
 * composer shows them (a blank line between paragraphs there too). Only bare `<p>` tags are touched (a signature's
 * styled paragraphs, tables and the rest are left exactly as they were).
 */
export function emailParagraphs(html: string): string {
  if (!html) return html;
  const out: string[] = [];
  let at = 0;
  let run: string[] | null = null;
  const flush = () => {
    if (!run) return;
    run.forEach((inner, i) => {
      if (i > 0) out.push("<div><br></div>");
      out.push(isBlank(inner) ? "<div><br></div>" : `<div>${inner}</div>`);
    });
    run = null;
  };
  for (const m of html.matchAll(BARE_P)) {
    const between = html.slice(at, m.index);
    // Paragraphs next to each other (only whitespace between) are one run; anything else ends it.
    if (between.trim()) { flush(); out.push(between); } else if (!run) out.push(between);
    (run ??= []).push(m[1]);
    at = m.index + m[0].length;
  }
  flush();
  out.push(html.slice(at));
  return out.join("");
}
