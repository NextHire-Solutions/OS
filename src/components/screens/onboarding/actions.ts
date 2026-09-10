"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { invalidate, loadOnce } from "../lazy";
import type { PersonRole } from "@/lib/tools/onboarding/people-types";

/*
 * The write half of Onboarding, from the browser.
 *
 * Shaped after `screens/client-health/actions.ts`: one `send` that turns a
 * non-2xx into an Error carrying the server's own sentence, and one exported
 * function per thing the user can do. Keeping them here rather than inline in the
 * components means every call site reports failures the same way — and that the
 * list of writes this screen can perform is one file you can read top to bottom.
 */

async function send(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error((body?.error as string | undefined) ?? `Request failed (${res.status})`);
  }
  return body ?? {};
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const BASE = "/api/tools/onboarding";

export const PIPELINE_URL = BASE;
export const STAGES_URL = `${BASE}/stages`;
export const TEMPLATES_URL = `${BASE}/templates`;
export const SETTINGS_URL = `${BASE}/settings`;

/* ------------------------------- stages ---------------------------------- */

export const createStage = (name: string) => send(STAGES_URL, json("POST", { name }));

export const renameStage = (id: string, name: string) =>
  send(`${STAGES_URL}/${id}`, json("PATCH", { name }));

export const recolourStage = (id: string, color: string) =>
  send(`${STAGES_URL}/${id}`, json("PATCH", { color }));

export const moveStage = (id: string, move: "up" | "down") =>
  send(`${STAGES_URL}/${id}`, json("PATCH", { move }));

/** Resolves with `{ moved }` — how many clients just became unplaced. */
export const removeStage = (id: string) => send(`${STAGES_URL}/${id}`, { method: "DELETE" });

/* ------------------------------ templates -------------------------------- */

export const createTemplate = (category: string) => send(TEMPLATES_URL, json("POST", { category }));

export const saveTemplate = (id: string, patch: { name?: string; subject?: string; body?: string }) =>
  send(`${TEMPLATES_URL}/${id}`, json("PATCH", patch));

export const removeTemplate = (id: string) => send(`${TEMPLATES_URL}/${id}`, { method: "DELETE" });

/* ------------------------------- settings -------------------------------- */

export const setAutomationEnabled = (on: boolean) =>
  send(SETTINGS_URL, json("PATCH", { automationEnabled: on }));

export const setStepLabels = (stepLabels: Record<string, string>) =>
  send(SETTINGS_URL, json("PATCH", { stepLabels }));

export const refreshHealthStatuses = () => send(`${BASE}/health`, { method: "POST" });

/* -------------------------------- clients -------------------------------- */

/** The manual move along the board. A label change — it runs nothing. */
export const setClientStage = (clientId: string, stageId: string | null) =>
  send(`${BASE}/clients/${clientId}`, json("PATCH", { stageId }));

/* -------------------------------- people --------------------------------- */

export const createPerson = (role: PersonRole, name: string, email: string, photo: string | null) =>
  send(`${BASE}/people`, json("POST", { role, name, email, photo }));

export const updatePerson = (
  id: string,
  patch: { name?: string; email?: string; photo?: string | null; active?: boolean; role?: PersonRole },
) => send(`${BASE}/people/${id}`, json("PATCH", patch));

/** Resolves with `{ hidden }` — nonzero when the person was hidden, not deleted. */
export const removePerson = (id: string) => send(`${BASE}/people/${id}`, { method: "DELETE" });

/* --------------------------- data, refetchable ---------------------------- */

/**
 * `Lazy`, but the caller can ask for the data again.
 *
 * `Lazy` is right for the read-only screens: it loads once and never again,
 * because nothing on the page can change what it loaded. These three screens
 * WRITE, so after every write the data they are rendering is stale by
 * definition. This is the same `loadOnce` cache — so a screen still costs one
 * request — plus `reload()`, which drops the cached promise first.
 *
 * Reloading rather than patching local state is the deliberate choice: it is the
 * only version that cannot drift from the database. Every control here is a
 * single small write followed by a re-read of a payload measured in kilobytes.
 */
export function useOnboardingData<T>(initial: T | null, url: string) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  // Guards against a state update after unmount during a slow fetch.
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (initial) return;
    loadOnce<T>(url).then(
      (d) => {
        if (live.current) setData(d);
      },
      (e: unknown) => {
        if (live.current) setError(e instanceof Error ? e.message : "Could not load");
      },
    );
  }, [initial, url]);

  const reload = useCallback(async () => {
    invalidate(url);
    try {
      const next = await loadOnce<T>(url);
      if (live.current) {
        setData(next);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "Could not reload");
    }
  }, [url]);

  return { data, error, reload };
}
