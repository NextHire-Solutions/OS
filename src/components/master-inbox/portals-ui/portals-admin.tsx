"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  ExternalLink,
  Pencil,
  Check,
  Loader2,
  Search,
  Users,
  Globe,
  Sparkles,
  ChevronRight,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/tools/master-inbox/utils";
import { Button } from "@/components/mi-ui/button";
import { Switch } from "@/components/mi-ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { publicPortalUrl } from "@/lib/tools/master-inbox/portals/public-url";
/*
 * The row type lives with the screen that builds it. In the tool that is the
 * portals PAGE; here it is the portals SCREEN, because the OS routes every
 * screen through one catch-all.
 */
import type { PortalClientRow } from "@/components/screens/master-inbox/portals";
import { STATUS_MEANING, STATUS_TONE, isClientStatus, statusLabel } from "@/lib/clients/client-status";
import { ClientCountLine, rowNote, useClientCounts } from "@/components/clients/count-line";
import { blockReason, confirmationMatches, protectedReason } from "@/lib/clients/delete-portal-rule";
import type { PortalDeletePlan } from "@/lib/clients/delete-portal";

// Absolute date for the "last intro" column — client asked for an
// explicit date instead of "Xh ago / 1mo ago" so it's easier to spot
// stale clients at a glance. Locale + UTC are fixed so the value is
// the same in any timezone the operator opens this page from.
function formatLastIntro(iso: string | null): string {
  if (!iso) return "No intros yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function clientInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/*
 * Rows of Master Inbox's table that this page does not list. The page's query
 * leaves the "Unknown" bucket out (it is not a portal), so the count line must
 * leave it out of its arithmetic too — screens/master-inbox/portals.tsx.
 */
const NOT_LISTED = ["Unknown"] as const;

export function PortalsAdmin({ rows, admin = false }: { rows: PortalClientRow[]; admin?: boolean }) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PortalClientRow | null>(null);
  /* The portal an admin has asked to delete — see DeletePortalDialog. */
  const [deleting, setDeleting] = useState<PortalClientRow | null>(null);
  /*
   * The one client count every tool's screen shows, from the reconciliation
   * the Consistency page is built on. Used here to say which rows are not one
   * more client: a second portal of a client, or the demo portal.
   */
  const counts = useClientCounts();
  /*
   * The client whose SMS alerts someone is about to turn ON. Turning it on
   * starts texting real people on that client's team, so it asks first — the
   * standalone inbox does the same with a browser confirm(); this is that
   * question in the workspace's own dialog. Turning it OFF never asks.
   */
  const [smsConfirm, setSmsConfirm] = useState<PortalClientRow | null>(null);
  const [smsSaving, setSmsSaving] = useState(false);
  const router = useRouter();

  async function saveSms(row: PortalClientRow, enabled: boolean) {
    setSmsSaving(true);
    let ok = false;
    try {
      ok = await patchPortal(row.id, { sms_alerts: enabled });
    } catch {
      // The request never reached the server (offline, a dropped connection).
      // Nothing was saved, and the switch still shows what the server holds —
      // say so rather than leave the dialog spinning on a promise that threw.
      toast.error("Couldn't reach the server — SMS alerts were not changed");
    } finally {
      setSmsSaving(false);
    }
    if (ok) {
      toast.success(enabled ? `SMS alerts on for ${row.name}` : `SMS alerts off for ${row.name}`);
      setSmsConfirm(null);
      router.refresh();
    }
  }

  const filtered =
    search.trim().length === 0
      ? rows
      : rows.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()));

  const totalIntros = rows.reduce((n, r) => n + r.intro_count, 0);
  const livePortals = rows.filter((r) => r.portal_enabled && r.portal_token).length;
  const withIntros = rows.filter((r) => r.intro_count > 0).length;

  return (
    /*
     * `mi-theme` re-points Tailwind's semantic tokens at the mockup's palette,
     * exactly as the other Master Inbox screens do; `mi-portals` scopes this
     * screen's own rules (src/app/mi-portals.css). This screen and the
     * drill-down were the only two inbox screens that carried neither, which is
     * most of why they still looked like the tool.
     *
     * flex-1 + overflow-y-auto: this page lives inside AppShell's <main>,
     * which is overflow-hidden — so the page must own its own scroll.
     */
    <div className="mi-theme mi-portals">
      <div className="mi-portals-wrap">
        {/* ---- Header ---- */}
        <div className="mi-portals-head">
          {/*
            * The workspace gives every screen the same header mark: a soft
            * tinted tile with one glyph (`.as-logo` in workspace.css). The
            * tool put the BrokerStaffer wordmark in a white box here, which
            * reads as a second brand sitting inside the workspace — and, since
            * the OS has no /portal/* route, rendered as a broken image.
            */}
          <div className="mi-portals-mark" aria-hidden>
            <Globe />
          </div>
          <div>
            <h1>Client Portals</h1>
            <p>
              Every client gets a private, login-free page of their Introduction
              leads. Manage and share the links here.
            </p>
          </div>
        </div>

        {/*
          * The same line every tool's client screen leads with (13 Oct: "Client
          * Portals should sync with Consistency"). This page said "57 clients"
          * while Consistency and every other screen said 54 — both true, of
          * different things: this is a list of PORTALS, and two clients have
          * two, plus the demo portal. So the clients are counted by the shared
          * line, and everything below it is called what it is: portals.
          */}
        <div data-portal-countline>
          <ClientCountLine tool="master_inbox" noun="portals" omit={NOT_LISTED} />
        </div>

        {/* ---- Summary ---- */}
        <div className="cards">
          <SummaryCard
            icon={Users}
            label="Portals"
            value={rows.length}
            hint={`${withIntros} with introductions`}
          />
          <SummaryCard
            icon={Globe}
            label="Live portals"
            value={livePortals}
            hint={`of ${rows.length} portals`}
          />
          <SummaryCard
            icon={Sparkles}
            label="Total introductions"
            value={totalIntros}
            hint="across all clients"
            accent
          />
        </div>

        {/* ---- Client list ---- */}
        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Portals</div>
              <div className="tbl-sub">
                {filtered.length === rows.length
                  ? `${rows.length} portals · ${livePortals} live`
                  : `${filtered.length} of ${rows.length} portals`}
              </div>
            </div>
            {/* ---- Search ---- */}
            <div className="srch">
              <Search />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search clients…"
                className="inp"
                aria-label="Search clients"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="px-[18px] py-16 text-center text-[13.5px] text-[#9aa0ab]">
              No clients match “{search}”.
            </div>
          ) : (
            <div className="tbl-scroll">
              {/* `mi-portals-list`: see mi-portals.css — the SMS column is paid
                  for out of the middle columns' padding, so the page is no
                  wider than it was before the column existed. */}
              <table className="mi-portals-list">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Status</th>
                    <th className="text-center">Intros</th>
                    <th>Last intro</th>
                    <th className="text-center">Team</th>
                    <th className="text-center">Agents</th>
                    <th className="text-center">DNC</th>
                    <th className="text-center">Live</th>
                    <th
                      className="text-center"
                      title="When on, the client's team gets a text for each new introduction"
                    >
                      SMS
                    </th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <PortalRow
                      key={r.id}
                      row={r}
                      note={rowNote(counts, "master_inbox", r.name)}
                      onDelete={admin ? () => setDeleting(r) : undefined}
                      onEdit={() => setEditing(r)}
                      onToggle={(enabled) => {
                        void patchPortal(r.id, { portal_enabled: enabled }).then((ok) => {
                          if (ok) {
                            toast.success(enabled ? "Portal enabled" : "Portal disabled");
                            router.refresh();
                          }
                        });
                      }}
                      onToggleSms={(enabled) => {
                        if (enabled) setSmsConfirm(r);
                        else void saveSms(r, false);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="anno">
          <TriangleAlert />
          <span>
            Anyone with a portal link can open it — <b>there is no password</b>.
            Keep the random suffix in each URL so links can&apos;t be guessed.
          </span>
        </p>
        {/* The standalone inbox's own line, word for word. */}
        <p className="mt-2 px-1 text-[12.5px] leading-relaxed text-[#7A8394]" data-portal-sms-note>
          SMS: when on, the client&apos;s team gets a text for each new
          introduction. Who on the team gets it is chosen with the SMS switches
          on their portal&apos;s Team page.
        </p>
        {admin ? (
          <p className="mt-1 px-1 text-[12.5px] leading-relaxed text-[#7A8394]" data-portal-delete-note>
            Deleting a portal (admins only): switch it off first — the delete
            button then takes the place of “Open live portal” in its row. The
            client itself is kept.
          </p>
        ) : null}
      </div>

      <DeletePortalDialog
        row={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          router.refresh();
        }}
      />

      <Dialog
        open={smsConfirm !== null}
        onOpenChange={(v) => {
          if (!v && !smsSaving) setSmsConfirm(null);
        }}
      >
        <DialogContent className="sm:max-w-md" data-portal-surface data-portal-sms-confirm>
          <DialogHeader>
            <DialogTitle>Turn on SMS alerts for {smsConfirm?.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-[13.5px] leading-relaxed text-[#5b6472]">
            From their next introduction, each person switched on in their
            portal&apos;s Team page gets a text (the first time, a welcome asking
            them to reply YES).
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSmsConfirm(null)} disabled={smsSaving}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (smsConfirm) void saveSms(smsConfirm, true);
              }}
              disabled={smsSaving}
            >
              {smsSaving ? <Loader2 className="size-4 animate-spin" /> : "Turn on SMS"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditPortalUrlDialog
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  hint: string;
  accent?: boolean;
}) {
  /*
   * The design leads with the LABEL and follows with a 32px number; the tool
   * led with a tinted tile and a 34px number, and spent a blue gradient on the
   * third card. The design has no gradient card — its emphasis is the accent
   * spent on the number itself (`.n-intros`), which is what `.card.accent`
   * does in mi-portals.css.
   */
  return (
    <div className={cn("card", accent && "accent")} data-portal-stat>
      <div className="card-top">
        <span className="card-ico">
          <Icon />
        </span>
        <span className="card-l">{label}</span>
      </div>
      <div className="card-n tnum">{value.toLocaleString()}</div>
      <div className="card-s">{hint}</div>
    </div>
  );
}

function PortalRow({
  row,
  note,
  onDelete,
  onEdit,
  onToggle,
  onToggleSms,
}: {
  row: PortalClientRow;
  /** Why this row is not one more client, when it is not (count-line's rowNote). */
  note: string | null;
  /** Present for admins only. */
  onDelete?: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onToggleSms: (enabled: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const portalPath = row.portal_token ? `/portal/${row.portal_token}` : null;
  // Brokerage-facing URL on the custom domain. Used for the row's
  // copy + open actions — staff share the portal.brokerstaffer.com
  // URL, NOT the Railway host.
  const portalAbsoluteUrl = publicPortalUrl(row.portal_token);
  const isLive = Boolean(row.portal_enabled && portalAbsoluteUrl);
  /*
   * Delete is offered where the delete would be ALLOWED — the same rule the
   * server applies (delete-portal-rule.ts), so the button never leads to a
   * refusal: not for the demo portal, and not while the portal is live.
   */
  const canDelete =
    Boolean(onDelete) &&
    blockReason({
      id: row.id,
      name: row.name,
      slug: row.slug,
      portalToken: row.portal_token,
      portalEnabled: row.portal_enabled,
    }) === null;

  function copyLink() {
    if (!portalAbsoluteUrl) return;
    navigator.clipboard.writeText(portalAbsoluteUrl).then(
      () => {
        setCopied(true);
        toast.success("Portal link copied");
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error("Couldn't copy"),
    );
  }

  return (
    <tr data-portal-row>
      {/* Client */}
      <td>
        <div className="flex min-w-0 items-center gap-3">
          <span className="mi-portals-av">{clientInitials(row.name)}</span>
          <div className="min-w-0 mi-portals-client">
            {/*
             * The OS routes every screen through one catch-all, so a client
             * drill-down is /portals/<id> (it was /inbox/portals/<id> until
             * Client Portals became its own product, 13 Oct). This used to link at
             * /portals/<id> — the tool's own path — which `idForPath` does not
             * recognise, so it fell through to Home. The 47-portal list linked
             * at a screen nobody could reach from it.
             */}
            <Link href={`/portals/${row.id}`} className="cname group block truncate" title={row.name}>
              {row.name}
              <ChevronRight className="ml-0.5 inline size-3.5 -translate-y-px text-[#c2c7d0] transition-transform group-hover:translate-x-0.5 group-hover:text-[#1565C0]" />
            </Link>
            {portalPath ? (
              <div className="csince truncate" title={portalPath}>{portalPath}</div>
            ) : (
              <div className="text-[11.5px] text-[#c23934]">No portal URL set</div>
            )}
            {note ? (
              <div className="csince truncate" title={note} data-portal-row-note>{note}</div>
            ) : null}
          </div>
        </div>
      </td>

      {/* Status — §11 names client-portal lists as the place status was
          missing. The master record's status, in the shared badge. */}
      <td>
        {row.status && isClientStatus(row.status) ? (
          <span className={`badge ${STATUS_TONE[row.status]}`} title={STATUS_MEANING[row.status]}>
            <span className="dot" />
            {statusLabel(row.status)}
          </span>
        ) : (
          <span className="text-[#9aa0ab]" title="Not linked to a master client (a demo or test portal)">—</span>
        )}
      </td>

      {/* Intros */}
      <td className="text-center">
        <span
          data-portal-intros
          className={cn(
            "inline-flex h-[26px] min-w-[34px] items-center justify-center rounded-lg px-2.5 text-[13px] font-semibold tabular-nums",
            row.intro_count > 0
              ? "bg-[#eaf2fd] text-[#1565C0]"
              : "bg-[#f0f1f4] text-[#9aa0ab]",
          )}
        >
          {row.intro_count}
        </span>
      </td>

      {/* Last intro */}
      <td className="text-[13px] text-[#5b6472] whitespace-nowrap">
        {formatLastIntro(row.last_intro_at)}
      </td>

      {/* §8 Portal view: team, agents, do-not-contact list. */}
      <td className="text-center tabular-nums">{row.team}</td>
      <td className="text-center tabular-nums">{row.agents.toLocaleString("en-US")}</td>
      <td className="text-center tabular-nums">{row.dnc.toLocaleString("en-US")}</td>

      {/* Portal toggle */}
      <td>
        <div className="flex justify-center">
          <Switch
            checked={row.portal_enabled}
            onCheckedChange={(v) => onToggle(Boolean(v))}
            aria-label="Portal enabled"
          />
        </div>
      </td>

      {/* SMS alerts toggle — the team_sms_notifications flag, the same one the
          standalone inbox's Client Portals page switches. */}
      <td>
        <div
          className="flex justify-center"
          title={row.sms_alerts ? "Team gets a text for each new introduction" : "No SMS alerts"}
        >
          <Switch
            checked={row.sms_alerts}
            onCheckedChange={(v) => onToggleSms(Boolean(v))}
            aria-label={`SMS alerts for ${row.name}`}
          />
        </div>
      </td>

      {/* Actions */}
      <td>
        <div className="flex items-center justify-end gap-0.5">
          <IconAction
            icon={copied ? Check : Copy}
            label="Copy link"
            onClick={copyLink}
            disabled={!portalAbsoluteUrl}
            on={copied}
          />
          <IconAction icon={Pencil} label="Edit URL" onClick={onEdit} />
          {isLive && portalAbsoluteUrl ? (
            <a
              href={portalAbsoluteUrl}
              target="_blank"
              rel="noopener"
              className="ib"
              aria-label="Open live portal"
              title="Open live portal"
            >
              <ExternalLink />
            </a>
          ) : canDelete ? (
            /* The slot "Open live portal" leaves empty once a portal is off:
               the two can never both apply, and a fourth button would make the
               page wider than a laptop screen (see mi-portals.css). */
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete the portal for ${row.name}`}
              title="Delete this portal (the client is kept)"
              className="ib ib-danger"
              data-portal-delete
            >
              <Trash2 />
            </button>
          ) : (
            <span
              className="inline-block size-[34px]"
              title={onDelete ? (protectedReason(row) ?? undefined) : undefined}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  on,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  // Momentary success state — the design tints the icon rather than swapping
  // the button, so the row does not shift when "Copied" flashes.
  on?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn("ib", on && "on")}
    >
      <Icon />
    </button>
  );
}

// PATCH helper shared by the toggle + the edit dialog.
async function patchPortal(
  clientId: string,
  patch: { portal_token?: string; portal_enabled?: boolean; sms_alerts?: boolean },
): Promise<boolean> {
  const res = await fetch(`/api/tools/master-inbox/clients/${clientId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    toast.error(json.error ?? "Update failed");
    return false;
  }
  return true;
}

function EditPortalUrlDialog({
  row,
  onClose,
  onSaved,
}: {
  row: PortalClientRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const open = row !== null;

  useEffect(() => {
    if (row) setToken(row.portal_token ?? "");
  }, [row?.id, row?.portal_token, row]);

  function onOpenChange(v: boolean) {
    if (!v) onClose();
  }

  async function save() {
    if (!row) return;
    const next = token.trim();
    if (next.length < 8) {
      toast.error("Portal URL must be at least 8 characters");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      toast.error("Only letters, numbers, hyphens and underscores");
      return;
    }
    if (next === row.portal_token) {
      onClose();
      return;
    }
    const ok = await patchPortal(row.id, { portal_token: next });
    if (ok) {
      toast.success("Portal URL updated");
      startTransition(() => onSaved());
    }
  }

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-portal-surface>
        <DialogHeader>
          <DialogTitle>Portal URL — {row.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="prow-k">Custom URL slug</label>
          <div className="flex items-center overflow-hidden rounded-[12px] border border-[#ebecf0] bg-white focus-within:border-[#bcd5f1] focus-within:ring-2 focus-within:ring-[#eaf2fd]">
            <span className="whitespace-nowrap border-r border-[#ebecf0] bg-[#fafbfc] px-3 py-2.5 font-mono text-[12px] text-[#9aa0ab]">
              /portal/
            </span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="flex-1 bg-transparent px-3 py-2.5 font-mono text-[13.5px] focus:outline-none"
              placeholder="brooklyn-group-a1b2c3"
              autoFocus
            />
          </div>
          <p className="text-[11.5px] leading-relaxed text-[#9aa0ab]">
            Anyone with this link can view the portal — there is no password. Keep
            the random suffix so it can&apos;t be guessed. Letters, numbers,
            hyphens and underscores only; 8 characters minimum.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : "Save URL"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * "28 leads, 3 agents and 1 team member" — only what the portal actually
 * holds. Naming four things at zero would bury the one number that matters.
 */
function lossList(c: PortalDeletePlan["cascade"]): string {
  const n = (count: number, one: string, many = `${one}s`) =>
    count > 0 ? `${count.toLocaleString("en-US")} ${count === 1 ? one : many}` : null;
  const parts = [
    n(c.pipelineEntries, "lead"),
    n(c.agents, "agent"),
    n(c.dncEntries, "do-not-contact entry", "do-not-contact entries"),
    n(c.teamMembers, "team member"),
  ].filter((x): x is string => x !== null);
  if (parts.length <= 1) return parts[0] ?? "contents";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/*
 * Delete ONE portal, and keep the client (13 Oct, admins only).
 *
 * Three things have to be true before anything is deleted, and each is its own
 * moment on screen rather than one button:
 *
 *   1. REVIEW   what goes and what stays, counted from the database just now
 *               (GET …/delete-plan) — "deletes its portal" says nothing about
 *               whether that portal is an empty shell or holds 400 agents.
 *   2. TYPE     the portal's name, and — when it holds anything — a ticked
 *               acknowledgement of exactly what is destroyed.
 *   3. CONFIRM  a last "are you sure", asked for by the user on 13 Oct
 *               ("before deleting, it should ask for the confirmation too").
 *
 * The server repeats every check (lib/clients/delete-portal.ts); this dialog
 * only decides what an admin is shown.
 */
function DeletePortalDialog({
  row,
  onClose,
  onDeleted,
}: {
  row: PortalClientRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [plan, setPlan] = useState<PortalDeletePlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [accept, setAccept] = useState(false);
  const [step, setStep] = useState<"review" | "confirm">("review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = row?.id ?? null;

  useEffect(() => {
    setPlan(null);
    setLoadError(null);
    setTyped("");
    setAccept(false);
    setStep("review");
    setBusy(false);
    setError(null);
    if (!id) return;
    let live = true;
    fetch(`/api/tools/master-inbox/clients/${id}/delete-plan`, { credentials: "same-origin" })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setLoadError(json.error ?? "Could not read this portal.");
        else setPlan(json as PortalDeletePlan);
      })
      .catch(() => {
        if (live) setLoadError("Couldn't reach the server. Nothing was changed.");
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (!row) return null;

  const needsAccept = Boolean(plan?.hasContent);
  const ready =
    plan !== null && !plan.blocked && confirmationMatches(typed, plan.name) && (!needsAccept || accept);

  async function run() {
    if (!row || !plan || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tools/master-inbox/clients/${row.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed, acceptDataLoss: accept }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        failed?: { what: string; error: string }[];
      };
      if (!res.ok) {
        // Refused or failed: nothing was deleted. Back to the review, with why.
        setError(json.error ?? "The portal was not deleted.");
        setStep("review");
        return;
      }
      if (json.failed?.length) {
        toast.warning(
          `Portal deleted, but: ${json.failed.map((f) => `${f.what} failed (${f.error})`).join("; ")}. Consistency will show it.`,
          { duration: 15000 },
        );
      } else {
        toast.success(
          plan.owner ? `Portal deleted — ${plan.owner.name} is still a client` : `Portal “${plan.name}” deleted`,
        );
      }
      onDeleted();
    } catch {
      setError("Couldn't reach the server. Check the list before trying again — the portal may or may not have been deleted.");
      setStep("review");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-portal-surface data-portal-delete-dialog data-step={step}>
        <DialogHeader>
          <DialogTitle>
            {step === "confirm" ? "Are you sure?" : `Delete the portal “${row.name}”?`}
          </DialogTitle>
        </DialogHeader>

        {step === "confirm" && plan ? (
          <div className="space-y-3 text-[13.5px] leading-relaxed text-[#5b6472]" data-portal-delete-final>
            <p>
              This permanently deletes the portal <b className="text-[#0f1320]">“{plan.name}”</b>
              {plan.hasContent ? " and everything inside it" : ""}. Its link stops working at once and cannot be
              brought back.
            </p>
            <p>
              {plan.owner ? (
                <>
                  The client <b className="text-[#0f1320]">{plan.owner.name}</b> is kept — in Clients, billing,
                  campaigns and every other tool.
                </>
              ) : (
                "No client record is changed."
              )}{" "}
              <b className="text-[#c23934]">There is no undo.</b>
            </p>
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-[13px] leading-relaxed text-[#5b6472]">
            {loadError ? (
              <p className="rounded-[10px] bg-[#fdecec] px-3 py-2.5 text-[#c23934]" data-portal-delete-error>
                {loadError}
              </p>
            ) : !plan ? (
              <p className="flex items-center gap-2 py-6 text-[#9aa0ab]">
                <Loader2 className="size-4 animate-spin" /> Checking what is inside this portal…
              </p>
            ) : plan.blocked ? (
              <p className="rounded-[10px] bg-[#fdecec] px-3 py-2.5 text-[#c23934]" data-portal-delete-blocked>
                {plan.blocked}
              </p>
            ) : (
              <>
                <div data-portal-delete-removes>
                  <b className="text-[#0f1320]">This removes</b>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {plan.willDelete.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
                {plan.willKeep.length ? (
                  <div data-portal-delete-keeps>
                    <b className="text-[#0f1320]">This keeps</b>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {plan.willKeep.map((k) => (
                        <li key={k}>{k}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.warnings.map((w) => (
                  <p key={w} className="text-[12.5px] text-[#8a5a0b]">
                    {w}
                  </p>
                ))}

                {needsAccept ? (
                  <label className="flex cursor-pointer items-start gap-2 rounded-[10px] border border-[#e9b4b0] bg-[#fdecec] px-3 py-2.5 text-[#0f1320]">
                    <input
                      id="portal-delete-accept"
                      type="checkbox"
                      checked={accept}
                      onChange={(e) => setAccept(e.target.checked)}
                      className="mt-[3px] cursor-pointer accent-[#c23934]"
                    />
                    <span data-portal-delete-accept-text>
                      I understand this permanently deletes this portal&apos;s {lossList(plan.cascade)}.
                    </span>
                  </label>
                ) : null}

                <div className="space-y-1.5">
                  <label htmlFor="portal-delete-name" className="block text-[12px] font-semibold text-[#5b6472]">
                    Type <b className="text-[#0f1320]">{plan.name}</b> to continue
                  </label>
                  <input
                    id="portal-delete-name"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={plan.name}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-[12px] border border-[#ebecf0] bg-white px-3 py-2.5 text-[13.5px] text-[#0f1320] focus:border-[#bcd5f1] focus:outline-none focus:ring-2 focus:ring-[#eaf2fd]"
                  />
                </div>
              </>
            )}
            {error ? (
              <p className="rounded-[10px] bg-[#fdecec] px-3 py-2.5 text-[#c23934]" data-portal-delete-error>
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {step === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => setStep("review")} disabled={busy}>
                Go back
              </Button>
              <Button variant="destructive" onClick={() => void run()} disabled={busy} data-portal-delete-go>
                {busy ? <Loader2 className="size-4 animate-spin" /> : "Yes, delete this portal"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {plan && !plan.blocked && !loadError ? "Cancel" : "Close"}
              </Button>
              {plan && !plan.blocked && !loadError ? (
                <Button
                  variant="destructive"
                  onClick={() => setStep("confirm")}
                  disabled={!ready}
                  data-portal-delete-continue
                >
                  Continue
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
