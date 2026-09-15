import { Building2 } from "lucide-react";
import type { SessionContext } from "@/lib/auth/workspace";

/*
 * The workspace the signed-in user is acting in.
 *
 * The tool draws this at the foot of its sidebar (`components/layout/
 * sidebar.tsx`), above Logout. The OS has no such sidebar — its rail is the
 * workspace's own — so the badge sits in Settings › Personal, which is where
 * the user-level facts about a session live here.
 *
 * Display only, as in the tool: the switch route exists
 * (/api/tools/master-inbox/workspaces/switch) but the tool's own `requireSession`
 * no longer reads the cookie it sets, and the tool offers no control that
 * calls it. Nothing is built here that the tool does not have.
 */
export function WorkspaceBadge({ session }: { session: SessionContext }) {
  return (
    <div className="w-full flex items-center gap-2 px-3 py-2 text-[13px]">
      <Building2 className="size-4 text-muted-foreground" strokeWidth={2} />
      <span className="truncate flex-1 text-left font-medium">
        {session.activeWorkspace.name}
      </span>
    </div>
  );
}
