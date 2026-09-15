/*
 * Settings › personal — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/personal/page.tsx`. The loaders
 * and the copy are the tool's; the MARKUP is the workspace's, because the tool
 * drew this with `rounded-lg border bg-card divide-y` and a `<Label>` /
 * `<Input>` pair, which is the tool's look rather than the mockup's.
 *
 * The email field is deliberately still a field rather than a line of text: it
 * is the same shape as the password fields under it, so the block reads as one
 * account form, and its read-only state is drawn (recessed, muted) rather than
 * merely asserted.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { requireSession } from "@/lib/auth/workspace";
import { ChangePasswordForm } from "@/components/master-inbox/settings/change-password-form";
import { WorkspaceBadge } from "@/components/master-inbox/workspace-badge";
import { signedInEmail } from "./signed-in-email";

export async function SettingsPersonal() {
  /*
   * `requireSession().user.email` is null in this workspace — see
   * `signed-in-email.ts`. It stays as the fallback so this keeps working if the
   * shim ever gains a real user, but the address on screen comes from the
   * verified request.
   */
  const [session, email] = await Promise.all([requireSession(), signedInEmail()]);
  return (
    <SettingsPageShell title="Personal details" description="Your account information.">
      <div className="mis-sec card">
        <div className="mis-h">Account</div>
        <div className="mis-sub">
          Your address is set by the workspace admin and cannot be changed here.
        </div>
        <div className="mis-form" style={{ maxWidth: 460, marginTop: 16 }}>
          <label className="mis-f" htmlFor="email">
            <span className="mis-l">Email</span>
            <input
              id="email"
              className="inp mis-ro"
              defaultValue={session.user.email ?? email}
              readOnly
              aria-readonly="true"
            />
          </label>
        </div>
      </div>

      {/*
        The tool shows the active workspace at the foot of its sidebar. The OS
        has no such sidebar, so the same badge lives here with the rest of the
        session's facts. See workspace-badge.tsx.
      */}
      <div className="mis-sec card">
        <div className="mis-h">Workspace</div>
        <div className="mis-sub">The Master Inbox workspace this account is working in.</div>
        <div style={{ marginTop: 8, marginLeft: -12 }}>
          <WorkspaceBadge session={session} />
        </div>
      </div>

      <div className="mis-sec card">
        <div className="mis-h">Change password</div>
        <div className="mis-sub">
          You will stay signed in on this device; other sessions are unaffected.
        </div>
        <div style={{ marginTop: 16 }}>
          <ChangePasswordForm />
        </div>
      </div>
    </SettingsPageShell>
  );
}
