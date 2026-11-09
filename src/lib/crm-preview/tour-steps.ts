/* The tour's steps, and where its card goes (tour.tsx draws them). */

import type { PreviewView } from "./model.ts";

export interface TourStep {
  title: string;
  text: string;
  /** The page to open behind it; none stays on the page it's on. */
  view?: PreviewView;
  /** What to point at; none is a card in the middle of the screen. */
  target?: string;
}

const nav = (view: PreviewView) => `nav a[href*="view=${view}"]`;

export const TOUR_STEPS: readonly TourStep[] = [
  { title: "Welcome to your portal", text: "A quick look at where everything lives. It takes about a minute, and nothing changes while you look around." },
  { title: "Pipeline", view: "pipeline", target: nav("pipeline"), text: "Every agent who replied interested, from first reply to hire. Move them through your stages as your conversations progress." },
  { title: "Reports", view: "reports", target: nav("reports"), text: "Your market and your interested agents, broken down by brokerage, office city, sales volume and deals." },
  { title: "Campaigns", view: "campaigns", target: nav("campaigns"), text: "Coming soon: edit your emails and create new campaigns here. Until then, our team runs your outreach for you." },
  { title: "Market", view: "market", target: nav("market"), text: "Every active agent in your market. Filter them, tick the ones you want and move them to Prospects, My Agents or your DNC List." },
  { title: "Prospects", view: "prospects", target: nav("prospects"), text: "The agents we reach for you. Remove agents here, or add them from Market, and your campaign is updated to match." },
  { title: "My Agents", view: "agents", target: nav("agents"), text: "The agents already at your brokerage. We never email anyone on this list." },
  { title: "DNC List", view: "dnc", target: nav("dnc"), text: "Anyone we should never contact, like sister offices, referral partners and former agents." },
  { title: "Team", view: "team", target: nav("team"), text: "Everyone at your brokerage who works interested agents. Add the people who will reply and book the call." },
  { title: "Integrations", view: "integrations", target: nav("integrations"), text: "Connect Follow Up Boss, and new agents in your Pipeline go straight into it too." },
  { title: "Billing", view: "billing", target: nav("billing"), text: "See your introductions for each billing period." },
  { title: "Help", view: "help", target: nav("help"), text: "Step-by-step articles and answers to common questions. You can take this tour again from here any time." },
  { title: "Chat with support", target: "a.crx-aiask", text: "Ask the assistant anything about your portal, or ask for a person." },
];

/** The hole's corners follow what it points at, 4px out: a round chat button gets a round hole, not a box around it. */
export function holeRadius(radius: string, width: number, height: number): number {
  const n = parseFloat(radius);
  const px = !Number.isFinite(n) ? 0 : radius.trim().endsWith("%") ? (Math.min(width, height) * n) / 100 : n;
  return Math.max(10, Math.min(px, Math.min(width, height) / 2) + 4);
}

export const CARD_WIDTH = 340;
const GAP = 12;
const EDGE = 16;

/** Where the card goes: beside what it points at, whichever side has room, and always inside the screen. */
export function cardPlace(hole: { top: number; left: number; width: number; height: number } | null, card: { width: number; height: number }, screen: { width: number; height: number }): { top: number; left: number } {
  if (!hole) return { top: Math.max(EDGE, (screen.height - card.height) / 2), left: Math.max(EDGE, (screen.width - card.width) / 2) };
  const right = hole.left + hole.width + GAP;
  const left = right + card.width + EDGE <= screen.width ? right : hole.left - GAP - card.width;
  const top = Math.min(hole.top, screen.height - card.height - EDGE);
  return { top: Math.max(EDGE, top), left: Math.max(EDGE, left) };
}
