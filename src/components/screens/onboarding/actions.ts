"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { invalidate, loadOnce } from "../lazy";
import type { PersonRole } from "@/lib/tools/onboarding/people-types";
import type { FieldType } from "@/lib/tools/onboarding/client-field-types";
import type { MlsOption } from "@/lib/tools/onboarding/client-leads";

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

/* -------------------------------- mailbox -------------------------------- */

/** "Check replies now" — reads the connected Gmail for replies; sends nothing. */
export const pollRepliesNow = () =>
  send(`${BASE}/mailbox/poll`, { method: "POST" }) as Promise<{ scanned?: number; matched?: number }>;

export const disconnectMailbox = () => send(`${BASE}/mailbox`, { method: "DELETE" });

/* -------------------------------- clients -------------------------------- */

/** The manual move along the board. A label change — it runs nothing. */
export const setClientStage = (clientId: string, stageId: string | null) =>
  send(`${BASE}/clients/${clientId}`, json("PATCH", { stageId }));

/* ---------------------------- one client --------------------------------- */

export const clientUrl = (clientId: string) => `${BASE}/clients/${clientId}`;
export const clientLeadsUrl = (clientId: string) => `${BASE}/clients/${clientId}/leads`;

/**
 * Every profile edit on the client detail screen, as one PATCH.
 *
 * All of them are labels: they write columns on one `orch_clients` row and reach
 * nothing outside this database — except that approving the copy with the
 * pipeline in automatic mode runs the set-up chain, as the tool does. The
 * things that reach outside on their own are `runStep` below.
 */
export type ClientPatch = {
  stageId?: string | null;
  accountManagerId?: string | null;
  salespersonName?: string;
  tacName?: string;
  mls?: string[];
  photo?: string | null;
  copyStatus?: "approved" | "rejected";
};

export const patchClient = (clientId: string, patch: ClientPatch) =>
  send(clientUrl(clientId), json("PATCH", patch));

/* --------------------------- custom fields -------------------------------- */

export const addClientField = (clientId: string, label: string, type: FieldType, value: string) =>
  send(`${clientUrl(clientId)}/fields`, json("POST", { label, type, value }));

export const updateClientField = (
  clientId: string,
  fieldId: string,
  patch: { label?: string; type?: FieldType; value?: string; move?: "up" | "down" },
) => send(`${clientUrl(clientId)}/fields/${fieldId}`, json("PATCH", patch));

export const removeClientField = (clientId: string, fieldId: string) =>
  send(`${clientUrl(clientId)}/fields/${fieldId}`, { method: "DELETE" });

/* ------------------------------- the MLS ---------------------------------- */

/**
 * Type-ahead for the MLS picker. A failed lookup is an empty list rather than a
 * thrown error: the picker is a suggestion box, and a red toast on every
 * keystroke while the network is slow would be worse than no suggestions.
 */
export async function lookupMls(term: string): Promise<MlsOption[]> {
  try {
    const body = await send(`${BASE}/mls?q=${encodeURIComponent(term)}`, { method: "GET" });
    return (body.options as MlsOption[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/* ----------------------------- the steps --------------------------------- */

/**
 * What the server says about a step press.
 *
 * `enabled` is false only for the steps that are switched off pending explicit
 * enablement (every email and the Stripe link — status 501). The others run:
 * 200 with what they did, 400 when the step's own precondition refused, 502 when
 * the external call failed (the delivery log has the detail).
 */
export type StepResult = {
  ok: boolean;
  enabled: boolean;
  error?: string;
  step?: string;
  label?: string;
  /** The external service the action calls. */
  target?: string;
  wouldDo?: string;
  reversible?: boolean;
  credential?: string;
  clientName?: string;
  /** What a successful action reported, e.g. a lead count or a campaign id. */
  detail?: Record<string, unknown>;
  /** For setup:remaining — one line per step of the chain. */
  chain?: { name: string; status: "ran" | "skipped" | "failed" | "pending"; detail?: string }[];
  /** 200 ran, 400 precondition, 404 no client, 501 switched off, 502 failed. */
  status: number;
};

/** Kept for callers that only ever see a refusal. */
export type StepRefusal = StepResult;

/**
 * Press a step button.
 *
 * DELIBERATELY NOT `send`. `send` throws a bare Error carrying only the server's
 * sentence, which would reduce "this would have started sending email to 300
 * agents" to a red toast. The whole body is kept so the screen can show what the
 * press did, or would have done.
 */
export async function runStep(clientId: string, step: string): Promise<StepResult> {
  const res = await fetch(`${clientUrl(clientId)}/steps`, {
    ...json("POST", { step }),
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    ...(body ?? {}),
    ok: res.ok && body?.ok === true,
    // 501 is the only "switched off"; anything else the OS was allowed to try.
    enabled: res.status !== 501 && body?.enabled !== false,
    error: (body?.error as string | undefined) ?? (res.ok ? undefined : `Request failed (${res.status})`),
    status: res.status,
  } as StepResult;
}

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
