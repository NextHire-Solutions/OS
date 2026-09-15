/*
 * The pure half of the Slack notifier — everything that shapes a message, with
 * nothing that sends one. Ported from the tool's `lib/slack.ts`.
 */

/**
 * Slack mrkdwn escape — REQUIRED for any external text (subjects, names) or
 * `<!channel>` in a client's email subject would ping the whole channel.
 */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");

/** The team mention prefix — "<!here>" by default; "" disables. */
export function mentionFrom(value: string | undefined): string {
  return value === undefined ? "<!here>" : value;
}

/** The head-of-thread announcement for a new intake. */
export function intakeHeadText(clientName: string): string {
  return `:tada: New client onboarded — *${esc(clientName)}*\n_Full intake answers in the thread_ :thread:`;
}

/** Slack's per-message display limit, with room to spare. */
export const SLACK_CHUNK = 3800;

/**
 * The Q&A as numbered items, chunked under Slack's per-message limit so a long
 * form arrives as several thread replies rather than one truncated one.
 */
export function intakeThreadChunks(qa: { q: string; a: string }[], limit = SLACK_CHUNK): string[] {
  const items = qa.map(({ q, a }, i) => `*${i + 1}. ${esc(q)}*\n${quote(esc(a))}`);
  const chunks: string[] = [];
  let cur = "";
  for (const it of items) {
    if (cur && cur.length + it.length > limit) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${it}` : it;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Gmail snippets arrive HTML-entity-encoded ("it&#39;s") — decode before display. */
export const decodeEntities = (s: string): string => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
