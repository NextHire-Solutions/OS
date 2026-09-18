import "server-only";

import { osTable } from "@/lib/clients/os-db";
import type { AiProvider } from "./label";

/*
 * Reading the corpus back and writing down what it says.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST PUT THE EXAMPLES IN THE PROMPT
 *
 * Retrieval already puts the nearest handful of real replies in front of the
 * model. What retrieval cannot give it is the things that are true EVERY time:
 * that we open with the first name, that we ask them to confirm the number and
 * the brokerage, that we never quote a split, that "I'm not the best person to
 * answer that" is an acceptable and much-used answer.
 *
 * So two documents are distilled once from the whole corpus and put in every
 * prompt:
 *
 *   the style guide      — how we write, in rules
 *   the objection playbook — how we answer each kind of pushback
 *
 * Both are stored as plain text and EDITABLE. A person's edit always wins: the
 * distillation proposes, it never overwrites a document that has been touched
 * by hand without being asked to.
 */

export interface DistilInput {
  workspaceId: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** How many examples to read. The whole corpus is ~1,300. */
  sample?: number;
  /*
   * Overwrite a document a person has edited.
   *
   * Off by default, and that default is the whole point — see
   * `distilKnowledge` below. The screen offers this as an explicit
   * "replace my edits" action, never as the ordinary Distil button.
   */
  force?: boolean;
}

export interface DistilResult {
  styleGuide: string;
  objectionPlaybook: string;
  readExamples: number;
  /** Which documents were written straight into os_agent_knowledge. */
  applied: KnowledgeTarget[];
  /** Which were held as proposals instead, because a person had edited them. */
  proposed: KnowledgeTarget[];
}

/** The two documents, named the way os_knowledge_proposals.target names them. */
export type KnowledgeTarget = "style" | "playbook";

const STYLE_SYSTEM = `You are studying one company's real sent email replies and writing down the house style, so that a new colleague could write the next reply and be indistinguishable.

Rules for your output:
- Write RULES, not description. "Open with the first name, no greeting line above it" — not "the writer tends to be informal".
- Only rules the examples actually support. If something appears once, leave it out.
- Include what they never do, where the examples make that clear.
- Cover: greeting, length, tone, how a question is answered, what is promised, sign-off, formatting.
- No preamble, no heading, no markdown fences. 12 rules at most, one per line, each starting with "- ".`;

const PLAYBOOK_SYSTEM = `You are studying one company's real sent email replies to leads and writing an objection playbook.

Group the replies by the SITUATION the lead put them in — for example: already happy at their brokerage, wants details before talking, suspicious of cost, wrong person, asking what this is about, ready to talk.

For each situation write:
  ## <the situation, in the lead's words>
  - how we answer it, in 2-4 rules
  - one short verbatim line from a real reply that shows it

Rules for your output:
- Only situations the examples actually contain, at most 8.
- Quote real lines, do not invent them.
- No preamble, no markdown fences.`;

async function complete(
  input: { provider: AiProvider; apiKey: string; model: string },
  system: string,
  user: string,
): Promise<string> {
  if (input.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`distil ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    return (json.content?.[0]?.text ?? "").trim();
  }

  const baseUrl = input.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.2,
      max_tokens: 2000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`distil ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Read the best of the corpus and write both documents.
 *
 * Samples by quality rather than taking the newest: the point is to learn from
 * the replies that worked, and quality already folds in recency and outcome.
 */
export async function distilKnowledge(input: DistilInput): Promise<DistilResult> {
  const sample = input.sample ?? 160;

  const { data, error } = await osTable("os_reply_examples")
    .select("label, inbound_text, reply_text, quality")
    .eq("workspace_id", input.workspaceId)
    .order("quality", { ascending: false })
    .limit(sample);
  if (error) throw new Error(`could not read the corpus: ${error.message}`);

  const rows = (data ?? []) as Array<{ label: string | null; inbound_text: string; reply_text: string }>;
  if (rows.length === 0) throw new Error("the corpus is empty — build it first");

  // Trim each example: the model needs the shape of the exchange, not every word.
  const transcript = rows
    .map((r, i) =>
      [
        `### Example ${i + 1}${r.label ? ` — situation: ${r.label}` : ""}`,
        `THEY WROTE: ${r.inbound_text.replace(/\s+/g, " ").slice(0, 500)}`,
        `WE REPLIED: ${r.reply_text.replace(/\s+/g, " ").slice(0, 700)}`,
      ].join("\n"),
    )
    .join("\n\n");

  const [styleGuide, objectionPlaybook] = await Promise.all([
    complete(input, STYLE_SYSTEM, transcript),
    complete(input, PLAYBOOK_SYSTEM, transcript),
  ]);

  /*
   * ---------------------------------------------------------------------------
   * A PERSON'S EDIT WINS.
   *
   * These two documents are the agent's instructions in plain English, and the
   * screen lets a person rewrite them. The moment someone does, this function
   * must stop being allowed to overwrite them — otherwise the next rebuild
   * silently discards a correction somebody made on purpose, and the agent
   * quietly reverts to the behaviour they were fixing.
   *
   * So a distillation that finds a hand-edited document does not write it. It
   * files the new text as a PROPOSAL in os_knowledge_proposals for a person to
   * accept or reject, and leaves the live document exactly as they left it.
   * `force` is the explicit override, offered on screen as "replace my edits".
   *
   * `updated_by` is the marker: "distillation" means this function wrote it
   * last and may write it again; anything else is a person's email address.
   */
  const current = await loadKnowledge(input.workspaceId);
  const editedByHand = !!current.updatedBy && current.updatedBy !== DISTILLED_BY;

  const applied: KnowledgeTarget[] = [];
  const proposed: KnowledgeTarget[] = [];
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    distilled_at: new Date().toISOString(),
    distilled_from: rows.length,
    updated_at: new Date().toISOString(),
  };

  const decide = (
    target: KnowledgeTarget,
    column: "style_guide" | "objection_playbook",
    next: string,
    existing: string | null,
  ) => {
    // Nothing to protect when the document is empty — the first distillation
    // after a hand-written style guide for the OTHER document must still land.
    const protect = editedByHand && !input.force && !!existing?.trim();
    if (protect) {
      proposed.push(target);
      return;
    }
    row[column] = next;
    applied.push(target);
  };

  decide("style", "style_guide", styleGuide, current.styleGuide);
  decide("playbook", "objection_playbook", objectionPlaybook, current.objectionPlaybook);

  /*
   * `updated_by` only moves back to "distillation" when this run actually
   * replaced BOTH documents. If a person's style guide survived, they are still
   * the last editor of the pair and a future run must keep asking.
   */
  if (applied.length === 2) row.updated_by = DISTILLED_BY;

  const { error: writeErr } = await osTable("os_agent_knowledge").upsert(row, { onConflict: "workspace_id" });
  if (writeErr) throw new Error(`could not save the knowledge: ${writeErr.message}`);

  if (proposed.length > 0) {
    const { error: propErr } = await osTable("os_knowledge_proposals").insert(
      proposed.map((target) => ({
        workspace_id: input.workspaceId,
        rule: target === "style" ? styleGuide : objectionPlaybook,
        /*
         * The evidence is how the proposal was reached, not a quote: the reader
         * needs to know it came from a fresh distillation over N examples
         * before deciding whether to trust it over their own wording.
         */
        evidence: [{ kind: "distillation", examples: rows.length, at: new Date().toISOString() }],
        target,
        status: "pending",
      })),
    );
    // A proposal that cannot be filed is worth reporting but not worth losing
    // the distillation over — the applied half has already been written.
    if (propErr) console.error("[ai:distil] could not file proposals", propErr.message);
  }

  return { styleGuide, objectionPlaybook, readExamples: rows.length, applied, proposed };
}

/** The value `updated_by` carries when this function, not a person, wrote last. */
export const DISTILLED_BY = "distillation";

export interface KnowledgeProposal {
  id: string;
  target: KnowledgeTarget;
  rule: string;
  evidence: unknown;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** Proposals waiting on a person, newest first. */
export async function listProposals(
  workspaceId: string,
  status: "pending" | "accepted" | "rejected" | "all" = "pending",
): Promise<KnowledgeProposal[]> {
  let q = osTable("os_knowledge_proposals")
    .select("id, target, rule, evidence, status, created_at, decided_at, decided_by")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  // Before migrations/0006 this table does not exist. "No proposals" is the
  // honest answer for a screen; an exception would take the whole panel down.
  if (error) {
    console.warn("[ai:distil] proposals unreadable:", error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    target: r.target as KnowledgeTarget,
    rule: (r.rule as string) ?? "",
    evidence: r.evidence,
    status: r.status as KnowledgeProposal["status"],
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
  }));
}

/**
 * Accept or reject one proposal.
 *
 * Accepting is what writes the proposed text into the live document — and it is
 * recorded as that PERSON's edit, not the distillation's, because a human chose
 * it. That keeps the protection above intact: the next distillation still has
 * to ask.
 */
export async function decideProposal(
  workspaceId: string,
  proposalId: string,
  decision: "accepted" | "rejected",
  by: string,
): Promise<{ applied: KnowledgeTarget | null }> {
  const { data, error } = await osTable("os_knowledge_proposals")
    .select("id, target, rule, status")
    .eq("workspace_id", workspaceId)
    .eq("id", proposalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That proposal no longer exists.");
  if ((data.status as string) !== "pending") throw new Error("That proposal has already been decided.");

  if (decision === "accepted") {
    const target = data.target as KnowledgeTarget;
    await saveKnowledge(
      workspaceId,
      target === "style"
        ? { styleGuide: (data.rule as string) ?? "" }
        : { objectionPlaybook: (data.rule as string) ?? "" },
      by,
    );
  }

  const { error: updErr } = await osTable("os_knowledge_proposals")
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by: by })
    .eq("workspace_id", workspaceId)
    .eq("id", proposalId);
  if (updErr) throw new Error(updErr.message);

  return { applied: decision === "accepted" ? (data.target as KnowledgeTarget) : null };
}

export interface Knowledge {
  styleGuide: string | null;
  objectionPlaybook: string | null;
  distilledAt: string | null;
  distilledFrom: number | null;
  updatedBy: string | null;
}

export async function loadKnowledge(workspaceId: string): Promise<Knowledge> {
  const { data } = await osTable("os_agent_knowledge")
    .select("style_guide, objection_playbook, distilled_at, distilled_from, updated_by")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return {
    styleGuide: (data?.style_guide as string | null) ?? null,
    objectionPlaybook: (data?.objection_playbook as string | null) ?? null,
    distilledAt: (data?.distilled_at as string | null) ?? null,
    distilledFrom: (data?.distilled_from as number | null) ?? null,
    updatedBy: (data?.updated_by as string | null) ?? null,
  };
}

/** A person's edit. Marked as theirs, so a later distillation knows to ask. */
export async function saveKnowledge(
  workspaceId: string,
  patch: { styleGuide?: string; objectionPlaybook?: string },
  by: string,
): Promise<void> {
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    updated_at: new Date().toISOString(),
    updated_by: by,
  };
  if (patch.styleGuide !== undefined) row.style_guide = patch.styleGuide;
  if (patch.objectionPlaybook !== undefined) row.objection_playbook = patch.objectionPlaybook;
  const { error } = await osTable("os_agent_knowledge").upsert(row, { onConflict: "workspace_id" });
  if (error) throw new Error(error.message);
}
