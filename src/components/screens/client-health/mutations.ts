"use client";

import {
  deleteConfirmText,
  optimisticClient,
  type ClientPayload,
} from "@/lib/tools/client-health/clientForm";
import type { DashboardClient } from "@/lib/tools/client-health/types";

import { createClient, deleteClient, updateClient } from "./actions";
import { addClientLocally, patchClient, patchClients, removeClientLocally } from "./load";
import { toast } from "./toast";

/*
 * The four writes Client Health's dashboard makes, wired to the store.
 *
 * Each one is: change the screen, send the request, put it back if it fails.
 * The tool does the same, and the ordering is the point — a pause button that
 * waits for a round trip reads as broken and gets pressed twice.
 *
 * Every failure is both rolled back AND said out loud. A silent rollback is
 * worse than no rollback: the row flicks back to where it was and the reader
 * concludes they misclicked.
 */

const why = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 140) : "Something went wrong";

export async function saveClient(
  editingId: string | null,
  payload: ClientPayload,
): Promise<boolean> {
  try {
    if (editingId) {
      await updateClient({ id: editingId, ...payload } as Parameters<typeof updateClient>[0]);
      patchClient(editingId, payload as Partial<DashboardClient>);
      toast("Client updated");
    } else {
      const body = (await createClient(payload as unknown as Record<string, unknown>)) as
        | { client?: { id?: string } }
        | null;
      const id = body?.client?.id;
      /*
       * No id back means the row exists but we cannot address it. Adding it to
       * the list under a made-up id would give the reader an Edit button that
       * silently patches nothing, so say what happened instead.
       */
      if (!id) {
        toast("Client added — reload to see it", true);
        return true;
      }
      addClientLocally(optimisticClient(id, payload));
      toast("Client added");
    }
    return true;
  } catch (error) {
    toast(`Save failed: ${why(error)}`, true);
    return false;
  }
}

/**
 * Deletes a client, after a confirmation that names what else goes with it.
 *
 * Returns false when the reader cancels, so callers can tell "declined" from
 * "failed" — only one of those is worth a message.
 */
export async function removeClient(c: DashboardClient): Promise<boolean> {
  if (!globalThis.confirm(deleteConfirmText(c))) return false;

  // Kept so the row can be put back in place if the request fails.
  const snapshot = c;
  removeClientLocally(c.id);

  try {
    const body = (await deleteClient(c.id)) as { orphansRemoved?: number } | null;
    const removed = ["client", "weekly metrics"];
    const orphans = body?.orphansRemoved ?? 0;
    if (orphans > 0) removed.push(`${orphans} orphan campaign${orphans === 1 ? "" : "s"}`);
    toast(`Removed: ${removed.join(" + ")}`);
    return true;
  } catch (error) {
    patchClients((list) => [...list, snapshot].sort((a, b) => a.name.localeCompare(b.name)));
    toast(`Delete failed: ${why(error)}`, true);
    return false;
  }
}

export async function setPaused(c: DashboardClient, paused: boolean): Promise<void> {
  patchClient(c.id, { client_paused: paused });
  try {
    await updateClient({ id: c.id, client_paused: paused } as Parameters<typeof updateClient>[0]);
    toast(
      paused
        ? "Client paused · use the Client Paused tab to recover"
        : "Client resumed",
    );
  } catch (error) {
    patchClient(c.id, { client_paused: !paused });
    toast(`Failed: ${why(error)}`, true);
  }
}

export async function setHidden(c: DashboardClient, hidden: boolean): Promise<void> {
  patchClient(c.id, { hidden });
  try {
    await updateClient({ id: c.id, hidden } as Parameters<typeof updateClient>[0]);
    toast(
      hidden
        ? "Client churned · use the Clients Churned tab to recover"
        : "Client restored",
    );
  } catch (error) {
    patchClient(c.id, { hidden: !hidden });
    toast(`Failed: ${why(error)}`, true);
  }
}
