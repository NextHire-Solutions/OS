import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/*
 * Railway's healthcheck target. It deliberately touches NOTHING — no upstream,
 * no cache warm, no env read that can throw. If this checked the five tools,
 * a sick upstream would make Railway restart *us*, which is the classic
 * health-check cascade.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "brokerstaffer-command-center",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  });
}
