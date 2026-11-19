/*
 * DUPLICATE & RENEW — the OS's links that name the old campaign by its id.
 *
 * The new campaign has a new EmailBison id, so two things the OS keys by
 * campaign id would keep pointing at the old one:
 *
 *   PORTAL ROUTE (os_campaign_portals, 0025) — which portal a multi-portal
 *     client's replies from this campaign go to. COPIED to the new id with the
 *     same portal and the same source ('manual' stays manual). The old row is
 *     KEPT: late replies to the old campaign still arrive and must still go to
 *     the same portal. (Without this the 10-minute auto pass would guess the
 *     new campaign's portal from its name, losing a person's choice.)
 *
 *   PROSPECTS — where the client's new Prospects are added: the team's pick on
 *     the client's Campaigns tab (os_campaign_list_clients: one campaign, or
 *     one per MLS in prospects_by_mls) and the campaign made at setup
 *     (os_setup_campaigns). Each that names the old campaign is MOVED to the
 *     new one — otherwise new prospects keep landing on the finishing old
 *     campaign. With no pick, Prospects already go to the newest sending
 *     campaign (campaign-lists/rules.ts), so nothing needs changing.
 *
 * Every write is told back as done or failed, never assumed.
 */

export type RouteSource = "auto" | "manual";

export interface PortalRoute {
  osClientId: string;
  miClientId: string;
  source: RouteSource;
}

export interface ProspectsPick {
  osClientId: string;
  /** "" = the client's one Prospects campaign; otherwise the MLS whose pick it is. */
  mlsCode: string;
}

export interface LinkState {
  /** False when the tables could not be read: the run is not offered (it could not keep these links). */
  ready: boolean;
  error: string | null;
  portalRoute: PortalRoute | null;
  /** Team picks naming the campaign. */
  picks: ProspectsPick[];
  /** Setup records naming the campaign. */
  setups: ProspectsPick[];
}

export interface LinkResult {
  portal: "copied" | "none" | "failed";
  picksMoved: number;
  setupsMoved: number;
  errors: string[];
}

/** The reads and writes, injectable so the rules are tested without a database. */
export interface LinkStore {
  route(campaignId: string): Promise<PortalRoute | null>;
  saveRoute(campaignId: string, campaignName: string, route: PortalRoute, by: string): Promise<void>;
  /** Every client's Prospects picks: its one campaign and its per-MLS map. */
  picks(): Promise<Array<{ osClientId: string; single: string | null; byMls: Record<string, { id: string; name?: string }> }>>;
  /** Only if the pick still names `fromId` (a change made meanwhile wins); resolves to whether it changed. */
  setPick(osClientId: string, mlsCode: string, fromId: string, toId: string, campaignName: string, by: string): Promise<boolean>;
  setups(campaignId: string): Promise<ProspectsPick[]>;
  /** Only if the record still names `fromId`; resolves to whether it changed. */
  setSetup(osClientId: string, mlsCode: string, fromId: string, toId: string, campaignName: string): Promise<boolean>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readLinks(campaignId: number, store: LinkStore): Promise<LinkState> {
  const id = String(campaignId);
  try {
    const [portalRoute, allPicks, setups] = await Promise.all([store.route(id), store.picks(), store.setups(id)]);
    const picks: ProspectsPick[] = [];
    for (const p of allPicks) {
      if (p.single === id) picks.push({ osClientId: p.osClientId, mlsCode: "" });
      for (const [code, pick] of Object.entries(p.byMls)) if (String(pick?.id) === id) picks.push({ osClientId: p.osClientId, mlsCode: code });
    }
    return { ready: true, error: null, portalRoute, picks, setups };
  } catch (e) {
    return { ready: false, error: msg(e), portalRoute: null, picks: [], setups: [] };
  }
}

/** Points every link the old campaign had at the new one. Each step on its own: one failing never stops the rest. */
export async function moveLinks(
  oldId: number,
  newId: number,
  newName: string,
  by: string,
  state: LinkState,
  store: LinkStore,
): Promise<LinkResult> {
  const out: LinkResult = { portal: "none", picksMoved: 0, setupsMoved: 0, errors: [] };
  const from = String(oldId);
  const to = String(newId);
  const who = `${by} (Duplicate & Renew from #${oldId})`;
  if (state.portalRoute) {
    try {
      await store.saveRoute(to, newName, state.portalRoute, who);
      out.portal = "copied";
    } catch (e) {
      out.portal = "failed";
      out.errors.push(`Portal choice not copied: ${msg(e)}`);
    }
  }
  for (const p of state.picks) {
    try {
      if (await store.setPick(p.osClientId, p.mlsCode, from, to, newName, who)) out.picksMoved++;
      else out.errors.push(`Prospects pick${p.mlsCode ? ` for ${p.mlsCode}` : ""} was changed by someone meanwhile, so it was left as they set it.`);
    } catch (e) {
      out.errors.push(`Prospects pick${p.mlsCode ? ` for ${p.mlsCode}` : ""} not moved: ${msg(e)}`);
    }
  }
  for (const s of state.setups) {
    try {
      if (await store.setSetup(s.osClientId, s.mlsCode, from, to, newName)) out.setupsMoved++;
      else out.errors.push(`Setup campaign record${s.mlsCode ? ` for ${s.mlsCode}` : ""} was changed meanwhile, so it was left as it is.`);
    } catch (e) {
      out.errors.push(`Setup campaign record${s.mlsCode ? ` for ${s.mlsCode}` : ""} not moved: ${msg(e)}`);
    }
  }
  return out;
}
