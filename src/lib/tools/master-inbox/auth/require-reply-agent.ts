import { NextResponse } from "next/server";

import { requireSession, type SessionContext } from "@/lib/auth/workspace";
import { isAdminUser } from "@/lib/identity/admin-db";
import { holdsPage } from "@/lib/identity/named-pages";
import { loadAgents } from "@/lib/tools/master-inbox/ai/agent";
import type { RunMode } from "@/lib/tools/master-inbox/ai/agent-config";

/** Admins, and the people the Reply agent page is opened to by name (identity/named-pages.ts). */
export async function canUseReplyAgent(email: string | null | undefined): Promise<boolean> {
  return holdsPage(email, "reply-agent") || (await isAdminUser(email));
}

/** The session, or a 403 — for the routes behind the Reply agent page. */
export async function requireReplyAgentSession(): Promise<SessionContext | NextResponse> {
  const session = await requireSession();
  if (!(await canUseReplyAgent(session.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can run this." }, { status: 403 });
  }
  return session;
}

/*
 * Putting an agent LIVE stays with admins (22 Oct audit). A live agent emails
 * real leads by itself, and the switch that allows it (live-gate.ts) is a
 * workspace setting, not a person's. Someone the page is opened to by name
 * (Amy) prepares and tunes agents in Shadow or Paused; she cannot switch one
 * to Live, nor change or delete one that is live. Run and release were
 * admin-only already.
 */
export function liveChangeRefusal(input: { admin: boolean; setsLive: boolean; currentMode: RunMode | null }): string | null {
  if (input.admin) return null;
  if (input.setsLive) return "Only an admin can put a reply agent live.";
  if (input.currentMode === "live") return "This agent is live — only an admin can change or delete it.";
  return null;
}

/** For the create, edit and delete routes: a 403 when a named (non-admin) person would touch Live. */
export async function refuseLiveChange(session: SessionContext, change: { setsLive: boolean; agentId?: string }): Promise<NextResponse | null> {
  const admin = await isAdminUser(session.user.email);
  if (admin) return null;
  const current = change.agentId ? (await loadAgents(session.activeWorkspace.id)).find((a) => a.id === change.agentId)?.run_mode ?? null : null;
  const why = liveChangeRefusal({ admin, setsLive: change.setsLive, currentMode: current });
  return why ? NextResponse.json({ error: why }, { status: 403 }) : null;
}
