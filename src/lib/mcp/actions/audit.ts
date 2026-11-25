import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { ActionAudit } from "./core.ts";

/*
 * os_mcp_actions (migrations/0058): the nonce is the primary key, so claiming it twice fails — a confirmation can act
 * once. The row stays as the record: who, which action, the arguments, the preview they confirmed, and how it ended.
 */
const MISSING = /os_mcp_actions|relation .* does not exist|schema cache/i;

export const auditStore: ActionAudit = {
  async claim(row) {
    const { error } = await osTable("os_mcp_actions").insert({
      nonce: row.nonce, email: row.email, action: row.action, args: row.args, preview: row.preview, status: "running",
    });
    if (!error) return true;
    if (/duplicate|unique|23505/i.test(error.message ?? "")) return false;
    if (MISSING.test(error.message ?? "")) throw new Error("Actions need migrations/0058_mcp_actions.sql run first. Nothing was done.");
    throw new Error(`Could not record the action, so it was not done: ${error.message}`);
  },
  async finish(nonce, outcome) {
    await osTable("os_mcp_actions")
      .update({
        status: outcome.ok ? "done" : "failed",
        result: outcome.ok ? (outcome.result ?? null) : null,
        error: outcome.ok ? null : (outcome.error ?? "failed"),
        finished_at: new Date().toISOString(),
      })
      .eq("nonce", nonce);
  },
};
