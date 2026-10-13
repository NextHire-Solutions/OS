import { NextResponse } from "next/server";

import { platformOfId } from "@/lib/tools/analytics/campaigns/campaign-id.ts";
import { CLIENT_FIELDS } from "@/lib/tools/analytics/campaigns/client-fields.ts";
import { clientFieldValuesForCampaign } from "@/lib/tools/analytics/campaigns/client-fields-load";

/*
 * What {CLIENT_AREA} and {CLIENT_ALIAS} will become on THIS campaign (13 Oct).
 *
 * Read-only, for the sequence editor: it shows the values before Save so
 * nobody has to save to find out what a field turns into — or that the
 * campaign has no client and the fields will stay as placeholders.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  try {
    const values = await clientFieldValuesForCampaign(platform, id);
    return NextResponse.json({
      client: values.clientName,
      fields: CLIENT_FIELDS.map((f) => ({ key: f.key, token: f.token, label: f.label, from: f.from, value: values[f.key] })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the campaign's client" }, { status: 502 });
  }
}
