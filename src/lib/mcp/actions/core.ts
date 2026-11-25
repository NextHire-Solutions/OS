/*
 * ACTIONS THROUGH THE CLAUDE CONNECTOR (25 Nov 2026). Eddy: "I am looking for the ability to take actions directly from
 * Claude". The user chose the first batch: inbox labels and snooze, and pausing / resuming a client's campaigns; for
 * admins and people named on identity/named-pages.ts "claude-connector" (empty until Eddy names someone).
 *
 * EVERY ACTION IS TWO CALLS.
 *  1. Without `confirm`: nothing changes. The action checks it is allowed and possible, and answers with a PREVIEW (what
 *     will happen, in words) and a `confirm` code.
 *  2. With that code, after the person has said yes in the chat: the action is checked again from scratch and, only if
 *     the preview still holds, done — once.
 *
 * The code is a signed token (mcp/tokens.ts, kind "action", 10 minutes) naming the person, the action, its exact
 * arguments, what the preview showed (`bind`, e.g. the current label, or the campaigns that would pause) and a nonce.
 * A code for someone else, another action, other arguments or an old preview is refused. The nonce is claimed in
 * os_mcp_actions BEFORE the action runs, so a repeated call can never act twice; that row is also the record of who did
 * what through Claude ("done by <email> via Claude").
 *
 * Who may: the same people who may do it on the OS screen — the switch of the screen's own route (grantsForRequest),
 * admins always. Which actions exist at all: OS_MCP_ACTIONS (switch.ts); unset = none, the connector stays read-only.
 *
 * Pure apart from the injected deps, so the whole flow is tested without a database (core.test.ts).
 */
import type { ToolId } from "@/lib/bs-auth";

export interface ActionViewer {
  email: string;
  admin: boolean;
  grants: readonly string[];
}

export type Preview<B> = { ok: true; preview: string; details?: unknown; bind: B } | { ok: false; refusal: string };

export interface ActionSpec<A = Record<string, unknown>, B = unknown> {
  name: string;
  title: string;
  description: string;
  /** The JSON schema of the action's own arguments (`confirm` is added for every action). */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** The switches that open the same action on the OS screen (grantsForRequest of its route). Admins always may. */
  needs: readonly ToolId[];
  /** Arguments checked and normalised, or why not. */
  parse(args: Record<string, unknown>): A | { error: string };
  /** Reads only. What would happen, or why it can't. */
  preview(a: A, v: ActionViewer): Promise<Preview<B>>;
  /** Does it. Only ever called after a fresh preview matched the confirmed one. */
  execute(a: A, v: ActionViewer, bind: B): Promise<unknown>;
}

export interface ActionAudit {
  /** Whether this nonce was claimed before — checked first, so a reused code is told so plainly. */
  used(nonce: string): Promise<boolean>;
  /** Claims the nonce. False when it was claimed before (the action already ran, or is running). */
  claim(row: { nonce: string; email: string; action: string; args: unknown; preview: string }): Promise<boolean>;
  finish(nonce: string, outcome: { ok: boolean; result?: unknown; error?: string }): Promise<void>;
}

export interface ActionDeps {
  sign(claims: Record<string, unknown>): Promise<string>;
  verify(token: string): Promise<Record<string, unknown> | null>;
  audit: ActionAudit;
  nonce(): string;
}

/** Same arguments, whatever the key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function mayUse(spec: Pick<ActionSpec, "needs">, v: ActionViewer): boolean {
  return v.admin || spec.needs.some((g) => v.grants.includes(g));
}

const CONFIRM_RULE =
  "Show this preview to the person in plain words and ask them to confirm. Only after they say yes in the chat, call " +
  "this tool again with the SAME arguments plus `confirm` set to this code. Never confirm on your own. The code works " +
  "once, for 10 minutes.";

export async function runAction(
  spec: ActionSpec,
  rawArgs: Record<string, unknown>,
  v: ActionViewer,
  deps: ActionDeps,
): Promise<Record<string, unknown>> {
  if (!mayUse(spec, v)) {
    return { done: false, refused: "You can't do this in the OS (the screen that does it isn't switched on for you)." };
  }
  const { confirm, ...args } = rawArgs;
  const parsed = spec.parse(args);
  if ("error" in parsed && Object.keys(parsed).length === 1) return { done: false, refused: (parsed as { error: string }).error };
  const a = parsed as Record<string, unknown>;

  const fresh = await spec.preview(a, v);
  if (!fresh.ok) return { done: false, refused: fresh.refusal };

  const issue = async () => ({
    done: false,
    preview: fresh.preview,
    ...(fresh.details === undefined ? {} : { details: fresh.details }),
    confirm: await deps.sign({ sub: v.email, act: spec.name, args: canonical(a), bind: canonical(fresh.bind), n: deps.nonce() }),
    next: CONFIRM_RULE,
  });

  if (confirm === undefined || confirm === null || confirm === "") return issue();

  const claims = await deps.verify(String(confirm));
  if (!claims || claims.sub !== v.email || claims.act !== spec.name || claims.args !== canonical(a)) {
    return { done: false, refused: "That confirmation code isn't valid for this action (expired, for other details, or for someone else). Nothing was done. Preview again." };
  }
  // A code used once never acts again — said before anything else (after an action, its preview has usually changed
  // too, which would otherwise answer "things changed" and offer a new code).
  const nonce = String(claims.n ?? "");
  if (!nonce || (await deps.audit.used(nonce))) {
    return { done: false, refused: "This confirmation was already used, so it was not done again." };
  }
  if (claims.bind !== canonical(fresh.bind)) {
    return { ...(await issue()), refused: "Things changed since the preview, so nothing was done. Here is the new preview; confirm again only if it is still right." };
  }

  if (!(await deps.audit.claim({ nonce, email: v.email, action: spec.name, args: a, preview: fresh.preview }))) {
    return { done: false, refused: "This confirmation was already used, so it was not done again." };
  }
  try {
    const result = await spec.execute(a, v, fresh.bind);
    await deps.audit.finish(nonce, { ok: true, result });
    return { done: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.audit.finish(nonce, { ok: false, error });
    return { done: false, failed: error };
  }
}

/** What Claude sees for one action: its schema with `confirm` added. */
export function actionTool(spec: ActionSpec) {
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} ACTION: call once without \`confirm\` for a preview (nothing changes), then again with the code it gives, only after the person confirms.`,
    inputSchema: {
      ...spec.inputSchema,
      properties: { ...spec.inputSchema.properties, confirm: { type: "string", description: "The code from this action's preview. Leave it out to preview." } },
    },
    annotations: spec.annotations,
  };
}
