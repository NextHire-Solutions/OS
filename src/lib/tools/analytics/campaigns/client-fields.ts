/*
 * Client fields in a sequence: {CLIENT_AREA} and {CLIENT_ALIAS} (13 Oct).
 *
 * OS feedback, both marked IMPORTANT: "Add 'Area' from Clients as merge field"
 * and "Add 'Client Alias' as merge field".
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE NOT ORDINARY MERGE FIELDS
 *
 * {FIRST_NAME} and {TOP PRODUCING CITY} are filled in by EmailBison at send
 * time, from the LEAD — a lead's custom variable is addressable by its name.
 * Area and Alias belong to the CLIENT, and EmailBison has no idea who our
 * clients are: it would send "{CLIENT_AREA}" to a real person, literally.
 *
 * So these two are filled in by the OS, at the moment a sequence is written to
 * a campaign, from the client that campaign belongs to. What EmailBison ends
 * up holding is the finished text ("greater Seattle"), never the placeholder.
 *
 *   · saving a sequence on a client's campaign fills them in;
 *   · copying a sequence INTO a client's campaign fills them for that client;
 *   · fanning a campaign out across clients fills each copy for its own client
 *     — which is the point: one template, every client's own area;
 *   · a campaign with NO client (a template) keeps the placeholders, so they
 *     are still there to be filled when it is copied or fanned out;
 *   · a campaign still holding a placeholder is refused when someone tries to
 *     start it sending.
 *
 * THE ONE PROPERTY EVERYTHING RESTS ON: a sequence with no client field in it
 * is not touched at all. `fillClientFields` hands back the very same string,
 * `fillSteps` the very same array, and no client is even looked up — so every
 * sequence that exists today behaves exactly as it did.
 *
 * Pure. Who a campaign's client is comes from client-fields-load.ts.
 */

export const CLIENT_FIELDS = [
  { key: "area", token: "{CLIENT_AREA}", label: "Client area", from: "Area on the client's record" },
  { key: "alias", token: "{CLIENT_ALIAS}", label: "Client alias", from: "the first alias on the client's record, else the client's name" },
] as const;

export type ClientFieldKey = (typeof CLIENT_FIELDS)[number]["key"];

export interface ClientFieldValues {
  /** Null when the campaign has no client. */
  clientName: string | null;
  area: string | null;
  alias: string | null;
}

export const NO_CLIENT: ClientFieldValues = { clientName: null, area: null, alias: null };

/*
 * Written {CLIENT_AREA}, but read forgivingly: any case, a space or an
 * underscore between the words, spaces inside the braces — the editor's menu
 * inserts the canonical form, and people type.
 */
const PATTERN: Record<ClientFieldKey, RegExp> = {
  area: /\{\s*CLIENT[ _]AREA\s*\}/gi,
  alias: /\{\s*CLIENT[ _]ALIAS\s*\}/gi,
};

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "Boston" · "Boston and Cape Cod" · "Boston, Cape Cod and the Islands" — how several areas read in a sentence. */
export function listAreas(areas: readonly unknown[] | null | undefined): string | null {
  const list = [...new Set((areas ?? []).map(clean).filter((a): a is string => a !== null))];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** A client's values for the two fields. No client → every value null. */
export function clientFieldValues(
  client: { name: string; aliases?: readonly unknown[] | null; areas?: readonly unknown[] | null } | null | undefined,
): ClientFieldValues {
  if (!client) return NO_CLIENT;
  const name = clean(client.name);
  const firstAlias = (client.aliases ?? []).map(clean).find((a): a is string => a !== null) ?? null;
  return { clientName: name, area: listAreas(client.areas), alias: firstAlias ?? name };
}

/** Which client fields a piece of text uses. */
export function clientFieldsIn(text: string | null | undefined): ClientFieldKey[] {
  if (!text) return [];
  return CLIENT_FIELDS.map((f) => f.key).filter((key) => {
    PATTERN[key].lastIndex = 0;
    return PATTERN[key].test(text);
  });
}

export function usesClientFields(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((t) => clientFieldsIn(t).length > 0);
}

export interface Filled<T> {
  value: T;
  /** How many placeholders were replaced. */
  filled: number;
  /** Fields used in the text that the client has no value for. Left as written. */
  missing: ClientFieldKey[];
}

/*
 * The text with each client field replaced by its value. A field with no
 * value is LEFT as its placeholder and reported — never replaced by an empty
 * string, which would send "agents in ." to a lead.
 */
export function fillClientFields(text: string, values: ClientFieldValues): Filled<string> {
  let out = text;
  let filled = 0;
  const missing: ClientFieldKey[] = [];
  for (const { key } of CLIENT_FIELDS) {
    PATTERN[key].lastIndex = 0;
    if (!PATTERN[key].test(out)) continue;
    const value = values[key];
    if (value === null) {
      missing.push(key);
      continue;
    }
    PATTERN[key].lastIndex = 0;
    out = out.replace(PATTERN[key], () => {
      filled++;
      return value;
    });
  }
  // The same string object when nothing was replaced — see the header.
  return { value: filled ? out : text, filled, missing };
}

interface StepText {
  email_subject?: string | null;
  email_body?: string | null;
}

/** Every step's subject and body filled. The same array when no step uses a client field. */
export function fillSteps<S extends StepText>(steps: readonly S[], values: ClientFieldValues): Filled<S[]> {
  let filled = 0;
  const missing = new Set<ClientFieldKey>();
  let touched = false;
  const out = steps.map((step) => {
    const subject = typeof step.email_subject === "string" ? fillClientFields(step.email_subject, values) : null;
    const body = typeof step.email_body === "string" ? fillClientFields(step.email_body, values) : null;
    for (const m of [...(subject?.missing ?? []), ...(body?.missing ?? [])]) missing.add(m);
    const n = (subject?.filled ?? 0) + (body?.filled ?? 0);
    if (!n) return step;
    filled += n;
    touched = true;
    return { ...step, ...(subject?.filled ? { email_subject: subject.value } : {}), ...(body?.filled ? { email_body: body.value } : {}) };
  });
  return { value: touched ? out : (steps as S[]), filled, missing: CLIENT_FIELDS.map((f) => f.key).filter((k) => missing.has(k)) };
}

const labelOf = (key: ClientFieldKey) => CLIENT_FIELDS.find((f) => f.key === key)!;

/*
 * Why a sequence cannot be written as it stands, or null when it can.
 *
 * `hasClient` false is not a problem: a template keeps its placeholders. A
 * client with no Area (or, impossibly, no name) is — there is nothing to put.
 */
export function clientFieldsProblem(missing: readonly ClientFieldKey[], values: ClientFieldValues): string | null {
  if (!missing.length || values.clientName === null) return null;
  const what = missing.map((k) => `${labelOf(k).token} (${labelOf(k).label.toLowerCase()})`).join(" and ");
  const where = missing.includes("area") ? " Add an Area on the client's record (Clients → the client → Markets), or take the field out." : " Take the field out, or add it to the client's record.";
  return `${values.clientName} has nothing on record for ${what}, so the sequence cannot be saved with it.${where}`;
}

/** Why a campaign must not start sending, or null when it may: it still holds a placeholder. */
export function unfilledProblem(fields: readonly ClientFieldKey[]): string | null {
  if (!fields.length) return null;
  const tokens = fields.map((k) => labelOf(k).token).join(" and ");
  return `The sequence still contains ${tokens}. A client field is only filled in on a campaign that belongs to a client — assign this campaign to a client and save its sequence, or remove the field, before it sends.`;
}
