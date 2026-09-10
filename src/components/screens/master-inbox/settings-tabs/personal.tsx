/*
 * Settings › personal — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/personal/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { requireSession } from "@/lib/auth/workspace";
import { Input } from "@/components/mi-ui/input";
import { Label } from "@/components/mi-ui/label";
import { ChangePasswordForm } from "@/components/master-inbox/settings/change-password-form";

export async function SettingsPersonal() {
  const session = await requireSession();
  return (
    <SettingsPageShell title="Personal details" description="Your account information.">
      <div className="rounded-lg border bg-card divide-y">
        <div className="p-6 space-y-4 max-w-lg">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" defaultValue={session.user.email ?? ""} readOnly disabled />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card divide-y mt-6">
        <div className="px-6 py-4">
          <h2 className="text-sm font-semibold">Change password</h2>
        </div>
        <ChangePasswordForm />
      </div>
    </SettingsPageShell>
  );
}
