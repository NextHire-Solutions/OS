/*
 * A client's own email copy, edited on the portal's Campaigns page (17 Nov 2026).
 *
 * Eddy and Amy (Slack, 16 Nov): clients edit their campaigns' emails on the portal's Campaigns tab, any time, with no
 * approval on BrokerStaffer's side, because the copy has to fit fixed rules: at most 125 words an email, no links or
 * images, plain text. They may change the wording, add or remove emails and change the days between them, and the
 * change goes live at once; every change is posted to #portal-update.
 *
 * Pure: no network, no database. campaigns.ts reads the campaign and writes the plan this file makes.
 *
 * THE SHAPE. EmailBison keeps a campaign's sequence as a flat list of steps. A step is either a main email (variant
 * false) or an A/B version of one (variant true, variant_from_step_id = the main step's id). Main steps go out in
 * `order`; a version is sent instead of its main step to some agents. `wait_in_days` is the gap AFTER a step (the
 * OS's own editors read it so: campaign-detail.tsx), so the last step's is unused. A follow-up sent as a reply in
 * the same thread (`thread_reply`) goes under the thread's subject; EmailBison stores and returns it with "Re: " in
 * front and adds that again on every write, so it is written back bare (bareSubject). Turned-off versions
 * (`active: false`) aren't sent; they are left exactly as they are.
 *
 * VERIFIED LIVE (17 Nov, a throwaway campaign that could not send): wording, subjects and waits of a RUNNING campaign
 * can be updated, an email added and an unsent one deleted, through the API, with no pause.
 *
 * WHAT A CLIENT MAY DO, AND WHAT IS CHECKED HERE (and nowhere else — the browser's checks are a courtesy):
 *   - change any email's wording, and the subject of any email not sent as a reply;
 *   - change the days between emails (1 to 30);
 *   - send a follow-up as a reply in the same thread, or as a new email with its own subject;
 *   - add emails at the end (10 at most), and remove one that hasn't been sent to anyone. Not the first email: it
 *     starts the thread every reply hangs off;
 *   - edit each A/B version's wording and subject. Versions aren't added or removed here.
 * Every email they change must fit the rules: plain text, no links, web or email addresses, at most 125 words, a
 * subject of at most 60 characters, and only the fields this campaign can fill ({FIRST_NAME} and the like). An email
 * they don't touch is left as the team wrote it, even if it wouldn't fit — it is never re-checked or rewritten.
 */

export const COPY_RULES = {
  maxWords: 125,
  maxSubject: 60,
  minWait: 1,
  maxWait: 30,
  maxEmails: 10,
} as const;

/** The fields every campaign can use (each in use across hundreds of BrokerStaffer's emails), with a sample for the preview. */
export const STANDARD_FIELDS: ReadonlyArray<{ key: string; label: string; sample: string }> = [
  { key: "FIRST_NAME", label: "Agent's first name", sample: "Jordan" },
  { key: "SENDER_FIRST_NAME", label: "Sender's first name", sample: "Alex" },
  { key: "SENDER_FULL_NAME", label: "Sender's full name", sample: "Alex Morgan" },
];

/** A step as EmailBison returns it (GET /api/campaigns/v1.1/{id}/sequence-steps), reduced to what this needs. */
export interface LiveStep {
  id: number;
  order: number | null;
  subject: string;
  body: string;
  wait: number;
  variant: boolean;
  /** A version's main step. */
  parentId: number | null;
  threadReply: boolean;
  active: boolean;
}

export interface CopyVersion {
  /** The step's id; null for an email being added. */
  id: number | null;
  /** Bare: no "Re: ". */
  subject: string;
  text: string;
  /** Sent as a reply in the thread (a version's own setting; version A's is the email's). */
  reply?: boolean;
}

export interface CopyEmail {
  /** The main step's id; null for an email being added. */
  id: number | null;
  /** Days after the previous email (null for the first). */
  waitBefore: number | null;
  threadReply: boolean;
  /** The main email first, then its A/B versions that are switched on. */
  versions: CopyVersion[];
  /** Emails already sent from this step (all versions). */
  sent: number;
  /** Turned off by the team: not sent, shown, left as it is. */
  off: boolean;
  /** Can be removed here: not the first, not sent, not off, no A/B versions (switched on or off). */
  removable: boolean;
}

export interface CopyModel {
  emails: CopyEmail[];
  /** The fields this campaign may use: the standard ones and any its emails already use. */
  fields: string[];
  /** A fingerprint of the sequence as read; a save against an older one is refused. */
  version: string;
}

export interface SaveEmail {
  id: number | null;
  waitBefore: number | null;
  threadReply: boolean;
  versions: Array<{ id: number | null; subject: string; text: string }>;
}

export interface SaveInput {
  version: string;
  emails: SaveEmail[];
}

/** One problem, where it is: email index, version index, the field. */
export interface CopyProblem {
  email: number;
  version?: number;
  field: "subject" | "text" | "wait" | "email";
  message: string;
}

export interface StepWrite {
  id?: number;
  /** Only its number changes (emails added or removed): sent only if EmailBison hasn't renumbered it already. Never sent to EmailBison. */
  orderOnly?: true;
  email_subject: string;
  email_body: string;
  order: number;
  wait_in_days: number;
  variant: boolean;
  variant_from_step_id?: number;
  thread_reply: boolean;
}

export type CopyPlan =
  | { ok: false; status: 409; code: "stale"; error: string }
  | { ok: false; status: 422; error: string; problems: CopyProblem[] }
  | {
      ok: true;
      /** Steps whose wording, subject, wait, thread or order changes — every one carries its id. */
      updates: StepWrite[];
      /** New emails, appended. */
      adds: StepWrite[];
      /** Step ids to delete, versions before their main step. */
      deletes: number[];
      /** What changed, in words, email by email (for Slack and the history). */
      summary: string[];
    };

/* -------------------------------------------------------------------------------------------- text <-> HTML --- */

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", times: "×", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tidy text: Unix line ends, no trailing spaces, at most one blank line in a row, no blank edges. */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** An email body as the plain text a client edits: paragraphs a blank line apart, line breaks kept, formatting dropped. */
export function htmlToText(html: string): string {
  const s = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
    .replace(/<(p|div|h[1-6]|li|blockquote|tr)(\s[^>]*)?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return normalizeText(decodeEntities(s).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n"));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text as the simple HTML EmailBison sends: a <p> per paragraph, <br> per line break. */
export function textToHtml(text: string): string {
  const t = normalizeText(text);
  if (!t) return "";
  return t
    .split(/\n\n/)
    .map((para) => `<p>${para.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/** EmailBison owns the "Re: " on a reply's subject and adds it on every write (sequence route's bareSubject). */
export function bareSubject(subject: string, threadReply: boolean): string {
  const s = String(subject ?? "");
  return threadReply ? s.replace(/^(?:re:\s*)+/i, "") : s;
}

/* ------------------------------------------------------------------------------------------- spintax/fields --- */

type Token = { kind: "text"; value: string } | { kind: "field"; key: string; raw: string } | { kind: "spin"; options: Token[][]; raw: string };

/** Splits copy into text, {FIELD}s and {a|b|c} choices (choices may hold fields or choices). Throws a message on bad braces. */
function tokenize(s: string): Token[] {
  let i = 0;
  let depth = 0;
  const parse = (inSpin: boolean): Token[][] => {
    const options: Token[][] = [[]];
    let text = "";
    const flush = () => { if (text) options[options.length - 1].push({ kind: "text", value: text }); text = ""; };
    while (i < s.length) {
      const c = s[i];
      if (c === "{") {
        flush();
        const start = i;
        i++;
        // The team's own copy goes 3 deep at most (2,625 steps, 17 Nov); deeper is refused, which also keeps every
        // count and check below quick (independent review: nesting made them exponential).
        if (++depth > MAX_DEPTH) throw new BraceError(`Choices inside choices can go ${MAX_DEPTH} levels deep at most: "${clip(s.slice(start))}".`);
        const inner = parse(true);
        depth--;
        if (s[i] !== "}") throw new BraceError(`A "{" isn't closed: "${clip(s.slice(start))}". Close it with "}".`);
        i++;
        const raw = s.slice(start, i);
        const only = inner[0];
        if (inner.length > 1) options[options.length - 1].push({ kind: "spin", options: inner, raw });
        else if (only.some((t) => t.kind !== "text")) {
          // One option holding a field or a choice — {{FIRST_NAME}}, {{Hi|Hello} there}: EmailBison sends what's inside
          // (checked 17 Nov on sent emails: "Hey {{FIRST_NAME}}," went out as "Hey Beverly,").
          options[options.length - 1].push({ kind: "spin", options: inner, raw });
        } else {
          const key = raw.slice(1, -1);
          options[options.length - 1].push({ kind: "field", key, raw });
        }
        continue;
      }
      if (c === "}") {
        if (!inSpin) throw new BraceError(`There's a "}" with no "{" before it: "${clip(s.slice(Math.max(0, i - 20), i + 1))}".`);
        flush();
        return options;
      }
      if (c === "|" && inSpin) {
        flush();
        options.push([]);
        i++;
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return options;
  };
  const out = parse(false);
  return out[0];
}

class BraceError extends Error {}

const MAX_DEPTH = 3;

/**
 * The copy with every choice at its longest by `measure`, each choice worked out ONCE (a choice inside a choice is not
 * re-rendered for every option around it — that was exponential).
 */
function longestRender(tokens: Token[], fill: (key: string) => string, measure: (s: string) => number): string {
  const best = new WeakMap<Token, string>();
  const renderAll = (ts: Token[]): string => ts.map((t) => (t.kind === "text" ? t.value : t.kind === "field" ? fill(t.key) : bestOf(t))).join("");
  const bestOf = (t: Token): string => {
    const hit = best.get(t);
    if (hit !== undefined) return hit;
    const options = (t as Extract<Token, { kind: "spin" }>).options.map(renderAll);
    const out = options.reduce((a, b) => (measure(b) > measure(a) ? b : a));
    best.set(t, out);
    return out;
  };
  return renderAll(tokens);
}

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/** A field name: capitals, digits, underscores and spaces ({FIRST_NAME}, {SUBJECT PHONE}). */
const FIELD_NAME = /^[A-Z][A-Z0-9_ ]*$/;

/** Every {FIELD} in a piece of copy (including inside choices). Bad braces: none. */
export function fieldsIn(s: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(s);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      if (t.kind === "field" && FIELD_NAME.test(t.key)) out.add(t.key);
      else if (t.kind === "spin") t.options.forEach(walk);
    }
  };
  walk(tokens);
  return [...out];
}

/** The copy as one agent might get it: each choice resolved by `pick`, each field by `fill`. */
function render(tokens: Token[], pick: (options: Token[][]) => Token[], fill: (key: string, raw: string) => string): string {
  return tokens
    .map((t) => (t.kind === "text" ? t.value : t.kind === "field" ? fill(t.key, t.raw) : render(pick(t.options), pick, fill)))
    .join("");
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Words in the longest way the copy can come out (each choice at its longest; a field is one word). Bad braces: null. */
export function wordCount(text: string): number | null {
  let tokens: Token[];
  try {
    tokens = tokenize(normalizeText(text));
  } catch {
    return null;
  }
  return words(longestRender(tokens, () => "W", words));
}

const sampleOf = (key: string) => STANDARD_FIELDS.find((f) => f.key === key)?.sample ?? null;

/** Characters in the longest way a subject can come out, fields as their sample (an unknown field as 10 characters). */
export function subjectLength(subject: string): number | null {
  let tokens: Token[];
  try {
    tokens = tokenize(subject.trim());
  } catch {
    return null;
  }
  return longestRender(tokens, (key) => sampleOf(key) ?? "xxxxxxxxxx", (x) => x.length).length;
}

/**
 * The copy as a sample agent gets it, for the preview: choice number `seed` (mod each choice's size), the standard
 * fields filled with samples, any other field left showing. Bad braces: the text as written.
 */
export function previewText(text: string, seed = 0): string {
  let tokens: Token[];
  try {
    tokens = tokenize(normalizeText(text));
  } catch {
    return text;
  }
  const pick = (options: Token[][]) => options[((seed % options.length) + options.length) % options.length];
  return render(tokens, pick, (key, raw) => sampleOf(key) ?? raw);
}

/* -------------------------------------------------------------------------------------------------- rules --- */

const LINK_PATTERNS: Array<[RegExp, string]> = [
  [/<\/?[a-z][^>]*>/i, "Plain text only: remove the formatting code"],
  [/!\[[^\]]*\]\(/, "Images aren't allowed"],
  [/\b(?:https?|ftp):\/\//i, "Links aren't allowed"],
  [/\bwww\d?\./i, "Web addresses aren't allowed"],
  [/\bmailto:/i, "Email addresses aren't allowed"],
  [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i, "Email addresses aren't allowed"],
  [/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|ai|app|biz|info|me|ly|gl|link|site|xyz|online|realty|realtor|homes|house|estate|properties|land|today|page|ca|uk|tv|ws|cc|gg|to|so|bit)\b(?!\.?[a-z])/i, "Web addresses aren't allowed"],
];

/**
 * A link split across choices — "acme{.|.}com", "bob{@|@}gmail{.|.}com" — reads as text above but goes out as a link
 * (independent review, 17 Nov). A link has no spaces in it, so only choices joined to each other and to the words
 * around them, with no space between, can build one: every way each such run can come out is checked. Fields count as
 * a word. A run with more ways than CAP is refused rather than half-checked (spaces between the choices fix it).
 */
const CAP = 5000;
function hiddenLink(tokens: Token[]): string | null {
  const TOO_MANY = "Too many choices are joined together here. Put a space between them.";
  let tooMany = false;
  const allWays = (ts: Token[]): string[] => {
    let acc = [""];
    for (const t of ts) {
      const opts = t.kind === "text" ? [t.value] : t.kind === "field" ? ["x"] : t.options.flatMap(allWays);
      // Every way, or a refusal — never a list cut short (a link could sit in the part cut off).
      if (acc.length * opts.length > CAP) { tooMany = true; return [""]; }
      acc = acc.flatMap((a) => opts.map((o) => a + o));
    }
    return acc;
  };
  type Piece = { text: string } | { ways: string[] };
  let run: Piece[] = [];
  const check = (): string | null => {
    const r = run;
    run = [];
    if (!r.some((p) => "ways" in p)) return null;
    let all = [""];
    for (const p of r) {
      const next = "text" in p ? [p.text] : p.ways;
      if (all.length * next.length > CAP) return TOO_MANY;
      all = all.flatMap((a) => next.map((n) => a + n));
    }
    for (const str of all) {
      for (const [re, message] of LINK_PATTERNS) {
        const m = re.exec(str);
        if (m) return `${message} ("${clip(m[0])}").`;
      }
    }
    return null;
  };
  for (const t of tokens) {
    if (t.kind === "spin") {
      const ways = t.options.flatMap(allWays);
      if (tooMany || ways.length > CAP) return TOO_MANY;
      run.push({ ways });
      continue;
    }
    const text = t.kind === "field" ? "x" : t.value;
    const first = text.search(/\s/);
    if (first === -1) { run.push({ text }); continue; }
    // The words up to the first space end this run; those after the last space start the next.
    run.push({ text: text.slice(0, first) });
    const p = check();
    if (p) return p;
    const last = text.search(/\S*$/);
    run = [{ text: text.slice(last) }];
  }
  return check();
}

/** What is wrong with one piece of copy, or null. `kind` picks the length rule. */
export function copyProblem(value: string, kind: "subject" | "text", allowedFields: ReadonlySet<string>): string | null {
  const v = kind === "text" ? normalizeText(value) : value.trim();
  if (!v) return kind === "text" ? "Write this email before saving." : "Add a subject.";
  if (kind === "subject" && /[\r\n]/.test(value.trim())) return "A subject has to be one line.";
  for (const [re, message] of LINK_PATTERNS) {
    const m = re.exec(v);
    if (m) return `${message} ("${clip(m[0])}").`;
  }
  let tokens: Token[];
  try {
    tokens = tokenize(v);
  } catch (e) {
    return e instanceof BraceError ? e.message : "Check the { } in this text.";
  }
  const hidden = hiddenLink(tokens);
  if (hidden) return hidden;
  const bad: string[] = [];
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      if (t.kind === "field") {
        if (!FIELD_NAME.test(t.key)) bad.push(t.raw);
        else if (!allowedFields.has(t.key)) bad.push(t.raw);
      } else if (t.kind === "spin") t.options.forEach(walk);
    }
  };
  walk(tokens);
  if (bad.length) {
    const first = bad[0];
    const inner = first.slice(1, -1);
    return FIELD_NAME.test(inner)
      ? `${first} isn't a field this campaign can fill. Use one of: ${[...allowedFields].map((f) => `{${f}}`).join(", ")}.`
      : `${first} isn't a field. For a choice of words write {first|second}; for a field, one of: ${[...allowedFields].map((f) => `{${f}}`).join(", ")}.`;
  }
  if (kind === "text") {
    const n = wordCount(v) ?? 0;
    if (n > COPY_RULES.maxWords) return `This email is ${n} words; the limit is ${COPY_RULES.maxWords}.`;
  } else {
    const n = subjectLength(v) ?? 0;
    if (n > COPY_RULES.maxSubject) return `This subject is ${n} characters; the limit is ${COPY_RULES.maxSubject}.`;
  }
  return null;
}

export function waitProblem(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isInteger(n)) return "Enter a whole number of days.";
  if (n < COPY_RULES.minWait || n > COPY_RULES.maxWait) return `Choose between ${COPY_RULES.minWait} and ${COPY_RULES.maxWait} days.`;
  return null;
}

/* -------------------------------------------------------------------------------------------- live -> model --- */

const byOrder = (a: LiveStep, b: LiveStep) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

/** A fingerprint of the sequence exactly as read (every step, switched on or off). */
export function sequenceVersion(steps: readonly LiveStep[]): string {
  const canon = [...steps]
    .sort((a, b) => a.id - b.id)
    .map((s) => [s.id, s.order, s.subject, s.body, s.wait, s.variant, s.parentId, s.threadReply, s.active]);
  // FNV-1a, 2 x 32 bits: not a secret, only "has this changed since it was read".
  const str = JSON.stringify(canon);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** The main steps in sending order. */
function mains(steps: readonly LiveStep[]): LiveStep[] {
  return steps.filter((s) => !s.variant).sort(byOrder);
}

/** A main step's switched-on versions, in order. */
function versionsOf(steps: readonly LiveStep[], main: LiveStep): LiveStep[] {
  return steps.filter((s) => s.variant && s.parentId === main.id && s.active).sort(byOrder);
}

/** The campaign as the editor shows it. `sent`: emails sent per step id. */
export function copyModel(steps: readonly LiveStep[], sent: ReadonlyMap<number, number> = new Map()): CopyModel {
  const m = mains(steps);
  const emails: CopyEmail[] = m.map((main, i) => {
    const vs = [main, ...versionsOf(steps, main)];
    return {
      id: main.id,
      waitBefore: i === 0 ? null : m[i - 1].wait,
      threadReply: main.threadReply,
      versions: vs.map((v) => ({ id: v.id, subject: bareSubject(v.subject, v.threadReply), text: htmlToText(v.body), reply: v.threadReply })),
      sent: [main, ...steps.filter((s) => s.variant && s.parentId === main.id)].reduce((n, s) => n + (sent.get(s.id) ?? 0), 0),
      off: !main.active,
      removable: i > 0 && main.active && !steps.some((s) => s.variant && s.parentId === main.id),
    };
  }).map((e) => ({ ...e, removable: e.removable && e.sent === 0 }));
  return { emails, fields: allowedFields(steps), version: sequenceVersion(steps) };
}

/** The standard fields and every field this campaign's emails use already (the team's own: {SUBJECT PHONE}, {AREA}). */
export function allowedFields(steps: readonly LiveStep[]): string[] {
  const set = new Set(STANDARD_FIELDS.map((f) => f.key));
  for (const s of steps) for (const f of [...fieldsIn(s.subject), ...fieldsIn(htmlToText(s.body))]) set.add(f);
  return [...set];
}

/* ------------------------------------------------------------------------------------------------- the plan --- */

const sameText = (a: string, b: string) => normalizeText(a) === normalizeText(b);

/**
 * What saving `input` over the sequence `steps` writes to EmailBison — or why it can't be saved. `sent`: emails sent
 * per step id (a step that has sent can't be removed; EmailBison refuses too).
 */
export function planCopySave(steps: readonly LiveStep[], input: SaveInput, sent: ReadonlyMap<number, number> = new Map()): CopyPlan {
  const model = copyModel(steps, sent);
  if (input.version !== model.version) {
    return { ok: false, status: 409, code: "stale", error: "This campaign's emails changed since you opened them. Reload to see the latest, then make your changes again." };
  }
  const fields = new Set(model.fields);
  const liveMains = mains(steps);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const modelById = new Map(model.emails.map((e) => [e.id as number, e]));
  const liveIndex = new Map(liveMains.map((s, i) => [s.id, i]));
  const emails = input.emails;
  const shape = (message: string): CopyPlan => ({ ok: false, status: 422, error: message, problems: [] });
  const stale = "This campaign's emails changed since you opened them. Reload and try again.";

  // ---- shape: what may be added, kept and removed
  if (!emails.length) return shape("A campaign needs at least one email.");
  // The team may have made a longer one: it can still be edited; only adding past the limit is refused.
  if (emails.length > Math.max(COPY_RULES.maxEmails, liveMains.length) || (emails.some((e) => e.id === null) && emails.length > COPY_RULES.maxEmails)) {
    return shape(`A campaign can have at most ${COPY_RULES.maxEmails} emails.`);
  }
  if (!liveMains.length || emails[0].id !== liveMains[0].id) return shape("The first email can't be removed or replaced: every follow-up is sent after it.");
  const seen = new Set<number>();
  let lastIndex = -1;
  let adding = false;
  for (const e of emails) {
    if (e.id === null) { adding = true; continue; }
    if (adding) return shape("New emails go after the existing ones.");
    const live = modelById.get(e.id);
    if (!live || seen.has(e.id)) return shape(stale);
    seen.add(e.id);
    const at = liveIndex.get(e.id)!;
    if (at < lastIndex) return shape("Emails can't be reordered here.");
    lastIndex = at;
    const want = live.versions.map((v) => v.id);
    const got = e.versions.map((v) => v.id);
    if (want.length !== got.length || want.some((id, i) => id !== got[i])) return shape(stale);
  }
  const removed = model.emails.filter((m) => !seen.has(m.id as number));
  for (const r of removed) {
    const n = liveIndex.get(r.id as number)! + 1;
    if (r.off) return shape(`Email ${n} was turned off by our team and can't be removed here.`);
    if (r.sent > 0) return shape(`Email ${n} has already been sent to ${r.sent.toLocaleString("en-US")} agent${r.sent === 1 ? "" : "s"}, so it can't be removed. You can change its wording.`);
    // Its versions would go first, and if EmailBison then refused the email (sent today, before our counts know) they'd
    // be lost. Rare (25 of 726 versions sit on a later email): our team removes those.
    if (steps.some((s) => s.variant && s.parentId === r.id)) return shape(`Email ${n} has A/B versions, so it can't be removed here. Ask us and our team will remove it.`);
  }

  /** The email before this one is the same one it followed before (so its "days after" means what it meant). */
  const sameBefore = (i: number) => {
    const e = emails[i];
    if (i === 0 || e.id === null) return false;
    const at = liveIndex.get(e.id)!;
    return at > 0 && emails[i - 1].id === liveMains[at - 1].id;
  };

  // ---- content: only what changed (or is new) is checked
  const problems: CopyProblem[] = [];
  emails.forEach((e, i) => {
    const was = e.id === null ? null : modelById.get(e.id)!;
    if (e.id === null && e.versions.length !== 1) problems.push({ email: i, field: "email", message: "A new email has one version." });
    if (was?.off) {
      // Turned off by the team: nothing of it may change — nor the gap in front of it, which is the live email before's.
      const gapMoved = !(sameBefore(i) && e.waitBefore === was.waitBefore);
      const changed = e.threadReply !== was.threadReply || e.versions.some((v, j) => !sameText(v.text, was.versions[j].text) || v.subject.trim() !== was.versions[j].subject.trim());
      if (changed) problems.push({ email: i, field: "email", message: "This email was turned off by our team and can't be changed here." });
      else if (gapMoved) problems.push({ email: i, field: "email", message: `Email ${i + 1} was turned off by our team, so the email before it, and the days between them, stay as they are.` });
      return;
    }
    if (i === 0 && e.threadReply !== (was?.threadReply ?? false)) problems.push({ email: i, field: "email", message: "The first email can't be sent as a reply." });
    if (i > 0 && !(sameBefore(i) && e.waitBefore === was!.waitBefore)) {
      const w = waitProblem(e.waitBefore);
      if (w) problems.push({ email: i, field: "wait", message: w });
    }
    const threadChanged = !!was && was.threadReply !== e.threadReply;
    e.versions.forEach((v, j) => {
      const old = was?.versions[j];
      if (!old || !sameText(v.text, old.text)) {
        const p = copyProblem(v.text, "text", fields);
        if (p) problems.push({ email: i, version: j, field: "text", message: p });
      }
      // A version follows the email's "reply" setting when the client changes it; otherwise it keeps its own.
      const replies = j === 0 || threadChanged ? e.threadReply : byId.get(v.id as number)?.threadReply ?? false;
      if (!replies && (!old || v.subject.trim() !== old.subject.trim() || threadChanged)) {
        const p = copyProblem(v.subject, "subject", fields);
        if (p) problems.push({ email: i, version: j, field: "subject", message: p });
      }
    });
  });
  if (problems.length) {
    return { ok: false, status: 422, error: problems.length === 1 ? problems[0].message : `${problems.length} things need fixing before this can be saved.`, problems };
  }

  // ---- the writes
  const reshaped = removed.length > 0 || emails.some((e) => e.id === null);
  /*
   * Orders. The main emails' stay as they are unless emails are added or removed; then they are 1..n in sending order,
   * new ones included. An A/B version's order is NEVER changed: EmailBison numbers versions apart from the sequence,
   * and giving one a number beside a main email's shifted the emails (copy-sequence.ts, from the team's own runs).
   * Checked live on 17 Nov: deleting an email renumbers the ones after it by itself; a new email beside a version's
   * number, and a version updated with its own number, leave everything in place. So an update that only renumbers
   * an email is marked `orderOnly`: the save sends it only if EmailBison hasn't already put that email there.
   */
  const targetOrder = new Map<number, number>();
  if (reshaped) emails.forEach((e, i) => { if (e.id !== null) targetOrder.set(e.id, i + 1); });
  // A version stored without a number gets one after every step, never beside a main email's — only if it is written.
  const spareOrder = Math.max(0, ...steps.map((s) => s.order ?? 0)) + 1;

  const updates: StepWrite[] = [];
  const adds: StepWrite[] = [];
  const summary: string[] = [];
  const firstSubject = bareSubject(liveMains[0].subject, liveMains[0].threadReply);
  const days = (n: number | null) => `${n} day${n === 1 ? "" : "s"}`;

  emails.forEach((e, i) => {
    // A step's wait is the gap AFTER it: the next email's "days after". The last one's is unused and kept.
    const next = emails[i + 1];
    const live = e.id === null ? null : byId.get(e.id)!;
    const wait = next ? (next.waitBefore as number) : live ? live.wait : COPY_RULES.minWait;
    if (!live) {
      const v = e.versions[0];
      adds.push({
        email_subject: e.threadReply ? firstSubject : v.subject.trim(),
        email_body: textToHtml(v.text),
        order: i + 1,
        wait_in_days: wait,
        variant: false,
        thread_reply: e.threadReply,
      });
      summary.push(`Added email ${i + 1}, ${days(e.waitBefore)} after email ${i}${e.threadReply ? ", as a reply in the same thread" : ""}`);
      return;
    }
    const was = modelById.get(live.id)!;
    const changes: string[] = [];
    if (i > 0) {
      if (!sameBefore(i)) changes.push(`now ${days(e.waitBefore)} after email ${i}`);
      else if (e.waitBefore !== was.waitBefore) changes.push(`now ${days(e.waitBefore)} after email ${i} (was ${days(was.waitBefore)})`);
    }
    if (was.threadReply !== e.threadReply) changes.push(e.threadReply ? "now sent as a reply in the same thread" : "now sent as a new email with its own subject");
    e.versions.forEach((v, j) => {
      const step = byId.get(v.id as number)!;
      const old = was.versions[j];
      const threadChanged = was.threadReply !== e.threadReply;
      const replies = j === 0 || threadChanged ? e.threadReply : step.threadReply;
      const textChanged = !sameText(v.text, old.text);
      const subjectChanged = !replies && (v.subject.trim() !== old.subject.trim() || threadChanged);
      const name = e.versions.length > 1 ? `version ${String.fromCharCode(65 + j)} ` : "";
      if (textChanged) changes.push(`${name}wording changed`);
      if (subjectChanged && v.subject.trim() !== old.subject.trim()) changes.push(`${name}subject changed`);
      const order = step.variant ? step.order ?? spareOrder : targetOrder.get(step.id) ?? step.order ?? i + 1;
      const stepWait = j === 0 ? wait : step.wait;
      const contentChanged = textChanged || subjectChanged || stepWait !== step.wait || replies !== step.threadReply;
      const moved = !step.variant && order !== step.order;
      if (!contentChanged && !moved) return;
      updates.push({
        ...(contentChanged ? {} : { orderOnly: true as const }),
        id: step.id,
        email_subject: subjectChanged ? v.subject.trim() : bareSubject(step.subject, step.threadReply),
        email_body: textChanged ? textToHtml(v.text) : step.body,
        order,
        wait_in_days: stepWait,
        variant: step.variant,
        ...(step.variant && step.parentId ? { variant_from_step_id: step.parentId } : {}),
        thread_reply: replies,
      });
    });
    if (changes.length) summary.push(`Email ${i + 1}: ${changes.join(", ")}`);
  });

  const deletes: number[] = [];
  for (const r of removed) {
    for (const v of steps.filter((s) => s.variant && s.parentId === r.id)) deletes.push(v.id);
    deletes.push(r.id as number);
    summary.push(`Removed email ${liveIndex.get(r.id as number)! + 1} (it hadn't been sent)`);
  }
  return { ok: true, updates, adds, deletes, summary };
}

/** The sequence after a plan is applied, as EmailBison would hold it (the Demo Portal's save, and the tests). */
export function applyPlan(steps: readonly LiveStep[], plan: Extract<CopyPlan, { ok: true }>, newId: () => number): LiveStep[] {
  const out = new Map(steps.map((s) => [s.id, { ...s }]));
  for (const u of plan.updates) {
    const s = out.get(u.id as number);
    if (!s) continue;
    Object.assign(s, { subject: u.thread_reply ? `Re: ${u.email_subject}` : u.email_subject, body: u.email_body, order: u.order, wait: u.wait_in_days, threadReply: u.thread_reply });
  }
  for (const a of plan.adds) {
    const id = newId();
    out.set(id, { id, order: a.order, subject: a.thread_reply ? `Re: ${a.email_subject}` : a.email_subject, body: a.email_body, wait: a.wait_in_days, variant: false, parentId: null, threadReply: a.thread_reply, active: true });
  }
  const gone = new Set(plan.deletes);
  return [...out.values()].filter((s) => !gone.has(s.id));
}
