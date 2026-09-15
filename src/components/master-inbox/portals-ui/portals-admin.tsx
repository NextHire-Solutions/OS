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

export function PortalsAdmin({ rows }: { rows: PortalClientRow[] }) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PortalClientRow | null>(null);
  const router = useRouter();

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

        {/* ---- Summary ---- */}
        <div className="cards">
          <SummaryCard
            icon={Users}
            label="Clients"
            value={rows.length}
            hint={`${withIntros} with introductions`}
          />
          <SummaryCard
            icon={Globe}
            label="Live portals"
            value={livePortals}
            hint={`of ${rows.length} clients`}
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
                  ? `${rows.length} clients · ${livePortals} live`
                  : `${filtered.length} of ${rows.length} clients`}
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
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="text-center">Intros</th>
                    <th>Last intro</th>
                    <th className="text-center">Live</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <PortalRow
                      key={r.id}
                      row={r}
                      onEdit={() => setEditing(r)}
                      onToggle={(enabled) => {
                        void patchPortal(r.id, { portal_enabled: enabled }).then((ok) => {
                          if (ok) {
                            toast.success(enabled ? "Portal enabled" : "Portal disabled");
                            router.refresh();
                          }
                        });
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
      </div>

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
  onEdit,
  onToggle,
}: {
  row: PortalClientRow;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const portalPath = row.portal_token ? `/portal/${row.portal_token}` : null;
  // Brokerage-facing URL on the custom domain. Used for the row's
  // copy + open actions — staff share the portal.brokerstaffer.com
  // URL, NOT the Railway host.
  const portalAbsoluteUrl = publicPortalUrl(row.portal_token);
  const isLive = Boolean(row.portal_enabled && portalAbsoluteUrl);

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
          <div className="min-w-0">
            {/*
             * The OS routes every screen through one catch-all, so a client
             * drill-down is /inbox/portals/<id>. This used to link at
             * /portals/<id> — the tool's own path — which `idForPath` does not
             * recognise, so it fell through to Home. The 47-portal list linked
             * at a screen nobody could reach from it.
             */}
            <Link href={`/inbox/portals/${row.id}`} className="cname group block truncate">
              {row.name}
              <ChevronRight className="ml-0.5 inline size-3.5 -translate-y-px text-[#c2c7d0] transition-transform group-hover:translate-x-0.5 group-hover:text-[#1565C0]" />
            </Link>
            {portalPath ? (
              <div className="csince truncate">{portalPath}</div>
            ) : (
              <div className="text-[11.5px] text-[#c23934]">No portal URL set</div>
            )}
          </div>
        </div>
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
          ) : (
            <span className="inline-block size-[34px]" />
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
  patch: { portal_token?: string; portal_enabled?: boolean },
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
