import "server-only";

import { getOnboardingDb } from "./db";


/**
 * Small key/value store for things the team tunes without a deploy — the
 * automation master switch and the custom labels they give the step buttons.
 *
 * Ported from the orchestrator's `lib/settings.ts`, including its cache. Reads
 * are held for a few seconds because the live orchestrator checks the automation
 * switch on every webhook and every scheduler tick, and it changes about once a
 * quarter.
 *
 * The cache is safe for a screen that WRITES because every write goes through
 * `setSetting`, which drops the key. A toggle therefore reads back its own new
 * value immediately rather than the ten-second-old one — the failure mode that
 * makes a settings page look broken.
 */

const TTL = 10_000;
const cache = new Map<string, { at: number; value: unknown }>();

/** Drops the whole cache. Exported for the tests. */
export function clearSettingsCache(): void {
  cache.clear();
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const { data } = await getOnboardingDb()
    .from("orch_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const value = data?.value === undefined || data?.value === null ? fallback : (data.value as T);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await getOnboardingDb()
    .from("orch_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  cache.delete(key);
  if (error) throw new Error(error.message);
}

/**
 * Master switch. OFF (the default since the manual-pipeline change) means
 * nothing fires on its own — no welcome email on booking, no setup chain on
 * approval, no auto-launch when the DB app imports leads. Every step waits for a
 * button.
 *
 * The guards themselves never turn off: work already done is still never
 * repeated.
 */
export async function automationEnabled(): Promise<boolean> {
  return getSetting<boolean>("automation_enabled", false);
}

/** Custom button captions, e.g. `{ "email:welcome": "Send the intro note" }`. */
export async function getStepLabels(): Promise<Record<string, string>> {
  return getSetting<Record<string, string>>("step_labels", {});
}

export { cleanStepLabels } from "./settings-pure";
