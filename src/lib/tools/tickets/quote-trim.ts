import { htmlToText } from "./gmail-message.ts";

/*
 * TICKETS — keep only the client's OWN words of an email (review, 20 Nov). A client's reply quotes our answer and
 * anyone earlier in the thread; a forward carries someone else's email. Under the user's rule ("only … emails that
 * came from client's email addresses. no other emails should be shown") none of that is kept: the quoted or
 * forwarded part is cut BEFORE storing, so it is never shown and never searched. Attachments the client added stay.
 *
 * HTML: cut at the first quote container Gmail, Outlook, Apple Mail, Yahoo or Thunderbird writes (everything after it
 * goes). Text: cut at "On … wrote:", "-----Original Message-----", "Forwarded message", Outlook's From/Sent block,
 * or a trailing block of "> " lines. When the text shows a quote the HTML markers didn't find, the HTML is dropped
 * and the trimmed text is kept instead: never risk showing quoted mail. Pure.
 */

const HTML_MARKERS: RegExp[] = [
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote(?:_container)?\b/i,
  /<blockquote\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b/i,
  /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b/i,
  /<div\b[^>]*\bid\s*=\s*["']?(?:divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)\b/i,
  /<hr\b[^>]*\bid\s*=\s*["']?stopSpelling\b/i,
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:yahoo_quoted|moz-cite-prefix|OutlookMessageHeader|protonmail_quote)\b/i,
  /<div\b[^>]*\bstyle\s*=\s*["'][^"']*border-top\s*:\s*solid\s+#(?:E1E1E1|B5C4DF)/i,
  /-{4,}\s*(?:Original Message|Forwarded message)\s*-{4,}/i,
  /Begin forwarded message:/i,
];

const TEXT_MARKERS: RegExp[] = [
  /(^|\n)[ \t>]*On [^\n]{2,250}(\n[^\n]{0,250})?\bwrote:[ \t]*(\n|$)/,
  /(^|\n)[ \t]*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i,
  /(^|\n)[ \t]*Begin forwarded message:/i,
  /(^|\n)[ \t]*_{8,}[ \t]*\n[ \t]*From:/,
  /(^|\n)[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[^\n]+\n/,
];

/** The client's own text, and whether anything was cut. */
export function trimText(text: string): { text: string; trimmed: boolean } {
  let cut = text.length;
  for (const re of TEXT_MARKERS) {
    const m = re.exec(text);
    if (m) cut = Math.min(cut, m.index + (m[1]?.length ?? 0));
  }
  // A closing block of "> " lines (plain-text quoting) after the client's words.
  const lines = text.slice(0, cut).split("\n");
  let end = lines.length;
  while (end > 0 && /^\s*(>.*)?$/.test(lines[end - 1])) end--;
  if (end < lines.length && lines.slice(end).some((l) => /^\s*>/.test(l)) && end > 0) cut = Math.min(cut, lines.slice(0, end).join("\n").length);
  const own = text.slice(0, cut).replace(/\s+$/, "");
  return { text: own, trimmed: cut < text.length && text.slice(cut).trim().length > 0 };
}

/** The client's own HTML (or null when it can't be trusted to hold only that), the own text, and whether anything was cut. */
export function trimEmail(html: string | null, text: string | null): { html: string | null; text: string | null; trimmed: boolean } {
  let ownHtml = html;
  let htmlCut = false;
  if (html) {
    let cut = html.length;
    for (const re of HTML_MARKERS) {
      const m = re.exec(html);
      if (m) cut = Math.min(cut, m.index);
    }
    if (cut < html.length) { ownHtml = html.slice(0, cut); htmlCut = true; }
  }
  const fromHtml = ownHtml ? htmlToText(ownHtml) : null;
  const t = trimText(text ?? (html ? htmlToText(html) : ""));
  if (ownHtml && !htmlCut && t.trimmed) {
    // The text shows a quote the HTML markers missed: show the trimmed text, not the HTML.
    return { html: null, text: t.text || null, trimmed: true };
  }
  if (ownHtml) {
    const own = trimText(fromHtml ?? "");
    return { html: ownHtml, text: (htmlCut ? own.text : t.text) || own.text || null, trimmed: htmlCut || t.trimmed || own.trimmed };
  }
  return { html: null, text: t.text || null, trimmed: t.trimmed };
}
