/*
 * payload.ts — how a scrape request is built.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE, PURE MODULE
 *
 * Starting a search spends money: Bright Data proxy traffic on Zillow and
 * Realtor, Realtor.com credits per enriched agent, and hours of a shared
 * container. A full Courted sweep re-scrapes up to 866,000 agents. So the one
 * thing that must NOT happen is "click Search to see if the payload is right".
 *
 * Pulling the construction out of the component makes it assertable without
 * being executable: the tests in agent-search.test.ts check the exact object
 * that WOULD be posted, byte for byte, and no request is ever made. That is
 * the only honest way to test a control whose side effect is a bill.
 *
 * Every field and default below is from web/server/index.js:367 and
 * web/public/app.js:startSearch / startAccountSweep.
 */

import { SOURCES, type SourceId } from "./columns.ts";
import { splitLocations } from "./format.ts";

export interface SearchForm {
  locations: string;
  sources: Record<SourceId, boolean>;
  courtedMax: string;
  minSalesVolume: string;
  courtedEnrich: boolean;
  courtedAllAgents: boolean;
  zillowMaxPages: string;
  zillowConcurrency: string;
  zillowEnrich: boolean;
  realtorMax: string;
  realtorConcurrency: string;
  realtorEnrich: boolean;
}

export interface SearchPayload {
  locations: string[];
  sources: SourceId[];
  courtedMax: number;
  minSalesVolume: number;
  courtedEnrich: boolean;
  courtedAllAgents: boolean;
  zillowMaxPages: number;
  zillowConcurrency: number;
  zillowEnrich: boolean;
  realtorMax: number;
  realtorConcurrency: number;
  realtorEnrich: boolean;
}

/** `+$('x').value || d` in app.js — NaN and 0 both fall back to the default. */
export function toInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n !== 0 ? n : fallback;
}

export type Refusal = { ok: false; error: string };
export type Built<T> = { ok: true; payload: T };

/**
 * The body the Search screen posts, or the reason it will not post one.
 *
 * The two refusals are the tool's own, and the second is subtler than it
 * looks: a Courted "all agents" run is an unfiltered MLS sweep that ignores
 * locations entirely, so an empty locations box is valid — but ONLY then.
 */
export function buildSearchPayload(form: SearchForm): Built<SearchPayload> | Refusal {
  const locations = splitLocations(form.locations);
  const sources = SOURCES.filter((s) => form.sources[s]);

  if (!locations.length && !form.courtedAllAgents) {
    return { ok: false, error: "Enter at least one location or ZIP (or tick Courted “All agents”)." };
  }
  if (!sources.length) return { ok: false, error: "Select at least one source." };

  return {
    ok: true,
    payload: {
      locations,
      sources,
      // 0 means "all matches" and is a real value, so these use `|| 0`
      // semantics: an empty box and an explicit 0 are the same request.
      courtedMax: Number.parseInt(form.courtedMax, 10) || 0,
      minSalesVolume: Number.parseInt(form.minSalesVolume, 10) || 0,
      courtedEnrich: form.courtedEnrich,
      courtedAllAgents: form.courtedAllAgents,
      zillowMaxPages: toInt(form.zillowMaxPages, 25),
      zillowConcurrency: toInt(form.zillowConcurrency, 4),
      zillowEnrich: form.zillowEnrich,
      realtorMax: Number.parseInt(form.realtorMax, 10) || 0,
      realtorConcurrency: toInt(form.realtorConcurrency, 3),
      realtorEnrich: form.realtorEnrich,
    },
  };
}

export interface SweepPayload {
  sources: ["courted"];
  courtedOnly: string[];
  courtedAllAgents: true;
  courtedBanded: true;
  courtedMlsIds?: string[];
}

/**
 * The body "Add account & start sweep" posts.
 *
 * Verbatim from app.js `startAccountSweep`. Three flags carry the meaning:
 *
 *   courtedOnly       target this ONE account, not all nine.
 *   courtedAllAgents  unfiltered sweep — every agent the login can see.
 *   courtedBanded     band pagination, which is how a 490,000-agent account
 *                     is walked without the offset sweep falling over.
 *
 * `courtedMlsIds` is omitted entirely for a whole-account sweep, never sent as
 * an empty array — the server reads a present-but-empty array the same way,
 * but omitting it is what the tool does and there is no reason to diverge.
 */
export function buildSweepPayload(email: string, mlsCodes: string[]): SweepPayload {
  const body: SweepPayload = {
    sources: ["courted"],
    courtedOnly: [email],
    courtedAllAgents: true,
    courtedBanded: true,
  };
  if (mlsCodes.length) body.courtedMlsIds = mlsCodes;
  return body;
}

export interface EnrichPayload {
  sheetUrl: string;
  csv: string;
  concurrency: number;
}

/** The body the Import screen posts. From app.js `importBody` + `startImport`. */
export function buildEnrichPayload(
  sheetUrl: string, csv: string, concurrency: string,
): Built<EnrichPayload> | Refusal {
  const s = sheetUrl.trim();
  if (!s && !csv.trim()) {
    return { ok: false, error: "Paste a Google Sheet link or a CSV of profile URLs first." };
  }
  return { ok: true, payload: { sheetUrl: s, csv, concurrency: toInt(concurrency, 4) } };
}
