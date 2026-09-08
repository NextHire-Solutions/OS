"use client";

import type { DashboardClient } from "@/lib/tools/client-health/types";

/*
 * Writes to Client Health, from the browser.
 *
 * Every one goes to a workspace API route, which proxies to the tool's own
 * endpoint. The browser never holds a credential for Client Health, and the
 * tool's validation, auto-linking and cascade rules all still apply — the
 * workspace has no opinion about what a valid client is.
 */

async function send(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const BASE = "/api/tools/client-health";

export interface SyncResult {
  instantly?: { campaigns?: number };
  corofy?: { intros?: number; skipped?: boolean };
}

/**
 * Runs Client Health's own sync worker.
 *
 * Slow on purpose — it walks Instantly and EmailBison. Callers must keep the
 * button disabled until it settles, or an impatient second press starts a
 * second full sweep.
 */
export async function runSync(): Promise<SyncResult> {
  const body = (await send(`${BASE}/sync`, { method: "POST" })) as
    | { result?: SyncResult }
    | null;
  return body?.result ?? {};
}

/** The tool's own summary wording for a completed sync. */
export function describeSync(r: SyncResult): string {
  const parts: string[] = [];
  if (r.instantly?.campaigns !== undefined) parts.push(`${r.instantly.campaigns} campaigns`);
  if (r.corofy?.skipped) parts.push("Corofy skipped");
  else if (r.corofy?.intros !== undefined) parts.push(`${r.corofy.intros} intros`);
  return parts.length ? `Synced · ${parts.join(" · ")}` : "Synced";
}

export type ClientPatch = Partial<DashboardClient> & { id: string };

/** Updates one client. The tool decides which fields it will accept. */
export function updateClient(patch: ClientPatch): Promise<unknown> {
  return send(`${BASE}/clients`, json("PATCH", patch));
}

export function createClient(client: Record<string, unknown>): Promise<unknown> {
  return send(`${BASE}/clients`, json("POST", client));
}

/**
 * Deletes a client.
 *
 * Cascading and irreversible in the tool — it removes the client's metrics and
 * campaign links too. Callers must confirm by name before calling this.
 */
export function deleteClient(id: string): Promise<unknown> {
  return send(`${BASE}/clients?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Pauses or resumes a client. Paused clients leave every other filter. */
export function setClientPaused(id: string, paused: boolean): Promise<unknown> {
  return updateClient({ id, client_paused: paused } as ClientPatch);
}

/*
 * There is deliberately no metric write here.
 *
 * The Weekly table's number cells look editable — they are <input> elements —
 * but the live tool marks them readOnly, and its /api/metrics/weekly is a GET.
 * Those figures come from Instantly, EmailBison and Master Inbox through the
 * sync worker; typing over one would be overwritten on the next sync and, in
 * the meantime, would make the dashboard disagree with the systems it reports
 * on. Our cells are readOnly for the same reason.
 */
