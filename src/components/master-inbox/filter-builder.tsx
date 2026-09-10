"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Tag as TagIcon,
  X,
  Plus,
  ChevronDown,
  Hash,
  Mail,
  AtSign,
  Globe,
  Eye,
  MessageSquare,
  RotateCcw,
  Type,
  Clock4,
  FileText,
  Megaphone,
  Building2,
} from "lucide-react";
import { Switch } from "@/components/mi-ui/switch";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/mi-ui/dialog";
import { LabelChip } from "@/components/master-inbox/label-chip";
import { cn } from "@/lib/tools/master-inbox/utils";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import type { ChannelRow } from "@/lib/tools/master-inbox/inbox/channels-shared";
import type { CampaignOption } from "@/lib/tools/master-inbox/inbox/campaigns";
import type { ClientOption } from "@/lib/tools/master-inbox/inbox/clients";
import {
  defaultRow,
  encodeFilter,
  FIELD_LABELS,
  type FilterField,
  type FilterOperator,
  type FilterRow,
  type FilterState,
} from "@/lib/tools/master-inbox/inbox/filters";

const FIELD_ICONS: Record<FilterField, React.ComponentType<{ className?: string }>> = {
  labels: TagIcon,
  channels: Hash,
  campaigns: Megaphone,
  clients: Building2,
  reply_since: Clock4,
  last_message_from: MessageSquare,
  message_counts: RotateCcw,
  read_status: Eye,
  subject: FileText,
  keywords: Type,
  name: Type,
  email: Mail,
  domain: Globe,
};

const FIELD_OPTIONS: FilterField[] = [
  "labels",
  "channels",
  "campaigns",
  "clients",
  "reply_since",
  "last_message_from",
  "message_counts",
  "read_status",
  "subject",
  "keywords",
  "name",
  "email",
  "domain",
];

const OPERATORS_BY_FIELD: Record<FilterField, FilterOperator[]> = {
  labels: ["is", "not"],
  channels: ["is", "not"],
  campaigns: ["is", "not"],
  clients: ["is", "not"],
  reply_since: ["greater_than", "less_than"],
  last_message_from: ["equals"],
  message_counts: ["equals", "greater_than", "less_than"],
  read_status: ["equals"],
  subject: ["contains"],
  keywords: ["contains"],
  name: ["contains", "equals"],
  email: ["contains", "equals"],
  domain: ["contains", "equals"],
};

const OP_LABELS: Record<FilterOperator, string> = {
  is: "IS",
  not: "NOT",
  equals: "Equals",
  greater_than: "Greater Than",
  less_than: "Less Than",
  contains: "Contains",
};

const REPLY_SINCE_SUBTYPES = [
  { value: "mi_user_reply", label: "MI User Reply" },
  { value: "lead_reply", label: "Lead Reply" },
];

const MESSAGE_COUNTS_SUBTYPES = [
  { value: "sent", label: "Sent Count" },
  { value: "received", label: "Received Count" },
];

export function FilterBuilder({
  open,
  onOpenChange,
  initial,
  labels,
  channels,
  campaigns,
  clients,
  currentViewId,
  currentViewName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: FilterState;
  labels: LabelRow[];
  channels: ChannelRow[];
  campaigns: CampaignOption[];
  clients: ClientOption[];
  currentViewId?: string | null;
  currentViewName?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [rows, setRows] = useState<FilterRow[]>(initial.rows);
  const [pending, startTransition] = useTransition();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!open) return null;

  function updateRow(id: string, patch: Partial<FilterRow>) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }

  function addRow(field: FilterField) {
    setRows((cur) => [...cur, defaultRow(field)]);
  }

  function apply() {
    const state: FilterState = { rows };
    const encoded = state.rows.length > 0 ? encodeFilter(state) : null;
    const url = encoded ? `${pathname}?f=${encoded}` : pathname;
    startTransition(() => {
      router.push(url);
      onOpenChange(false);
    });
  }

  async function save() {
    setSaveError(null);
    const filter_json: Record<string, unknown> = {
      preset: "custom_filter",
      rows,
    };
    const res = await fetch("/api/tools/master-inbox/custom-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: saveName, filter_json }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setSaveError(json.error ?? "Save failed");
      return;
    }
    const slug = saveName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setSaveOpen(false);
    onOpenChange(false);
    startTransition(() => {
      router.refresh();
      router.push(`/inbox/${slug}`);
    });
  }

  async function updateExisting() {
    if (!currentViewId) return;
    const filter_json: Record<string, unknown> = {
      preset: "custom_filter",
      rows,
    };
    const res = await fetch(`/api/tools/master-inbox/custom-views/${currentViewId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter_json }),
    });
    if (!res.ok) return;
    onOpenChange(false);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <div className="absolute z-30 left-3 top-11 w-[920px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card shadow-lg p-4">
        <div className="space-y-2">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2 px-2">
              No filters yet. Add one below to refine the threads in this view.
            </p>
          ) : null}

          {rows.map((row) => (
            <FilterRowEditor
              key={row.id}
              row={row}
              labels={labels}
              channels={channels}
              campaigns={campaigns}
              clients={clients}
              onChange={(patch) => updateRow(row.id, patch)}
              onRemove={() => removeRow(row.id)}
            />
          ))}

          <div className="flex items-center justify-between pt-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-md hover:bg-accent"
                  >
                    <Plus className="size-4" />
                    Add more
                  </button>
                }
              />
              <DropdownMenuContent align="start" className="w-56 max-h-80 overflow-y-auto">
                {FIELD_OPTIONS.map((f) => {
                  const Icon = FIELD_ICONS[f];
                  return (
                    <DropdownMenuItem key={f} onClick={() => addRow(f)}>
                      <Icon className="size-3.5 mr-2 text-muted-foreground" />
                      {FIELD_LABELS[f]}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              {currentViewId ? (
                <Button variant="outline" size="sm" onClick={updateExisting} disabled={pending}>
                  Save to {currentViewName ?? "view"}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSaveName("");
                  setSaveError(null);
                  setSaveOpen(true);
                }}
                disabled={rows.length === 0}
              >
                Save as new view
              </Button>
              <Button size="sm" onClick={apply} disabled={pending} className="gap-1.5">
                Apply Filter
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as new view</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium">View name</label>
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. Hot Leads"
              autoFocus
            />
            {saveError ? <p className="text-xs text-red-600">{saveError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!saveName.trim() || pending}>
              Create view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// One condition row. Each row owns: enabled toggle, field selector, operator
// selector (or subtype dropdown for reply_since/message_counts), value editor.
function FilterRowEditor({
  row,
  labels,
  channels,
  campaigns,
  clients,
  onChange,
  onRemove,
}: {
  row: FilterRow;
  labels: LabelRow[];
  channels: ChannelRow[];
  campaigns: CampaignOption[];
  clients: ClientOption[];
  onChange: (patch: Partial<FilterRow>) => void;
  onRemove: () => void;
}) {
  const Icon = FIELD_ICONS[row.field];
  const opOptions = OPERATORS_BY_FIELD[row.field];

  return (
    <div className="flex items-center gap-2">
      <Switch checked={row.enabled} onCheckedChange={(v) => onChange({ enabled: v })} />

      {/* Field picker */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm min-w-[160px] justify-between hover:bg-accent"
            >
              <span className="inline-flex items-center gap-2">
                <Icon className="size-3.5 text-muted-foreground" />
                {FIELD_LABELS[row.field]}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-56 max-h-80 overflow-y-auto">
          {FIELD_OPTIONS.map((f) => {
            const IconF = FIELD_ICONS[f];
            return (
              <DropdownMenuItem
                key={f}
                onClick={() => onChange(defaultRow(f))}
              >
                <IconF className="size-3.5 mr-2 text-muted-foreground" />
                {FIELD_LABELS[f]}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Subtype picker for reply_since / message_counts */}
      {row.field === "reply_since" ? (
        <SubtypeSelect
          options={REPLY_SINCE_SUBTYPES}
          value={row.subtype ?? "mi_user_reply"}
          onChange={(v) => onChange({ subtype: v })}
        />
      ) : null}
      {row.field === "message_counts" ? (
        <SubtypeSelect
          options={MESSAGE_COUNTS_SUBTYPES}
          value={row.subtype ?? "sent"}
          onChange={(v) => onChange({ subtype: v })}
        />
      ) : null}

      {/* Operator picker */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm min-w-[120px] justify-between hover:bg-accent"
            >
              <span>{OP_LABELS[row.operator]}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          {opOptions.map((op) => (
            <DropdownMenuItem key={op} onClick={() => onChange({ operator: op })}>
              {OP_LABELS[op]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Value editor — depends on field */}
      <div className="flex-1 min-w-0">
        <ValueEditor row={row} labels={labels} channels={channels} campaigns={campaigns} clients={clients} onChange={onChange} />
      </div>

      <button
        type="button"
        onClick={onRemove}
        className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-red-600 transition-colors"
        aria-label="Remove filter"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function SubtypeSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm min-w-[150px] justify-between hover:bg-accent"
          >
            <span>{current?.label}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ValueEditor({
  row,
  labels,
  channels,
  campaigns,
  clients,
  onChange,
}: {
  row: FilterRow;
  labels: LabelRow[];
  channels: ChannelRow[];
  campaigns: CampaignOption[];
  clients: ClientOption[];
  onChange: (patch: Partial<FilterRow>) => void;
}) {
  if (row.field === "campaigns") {
    const selected = Array.isArray(row.value) ? (row.value as string[]) : [];
    return (
      <MultiPickerCampaigns
        all={campaigns}
        selected={selected}
        onChange={(next) => onChange({ value: next })}
      />
    );
  }
  if (row.field === "clients") {
    const selected = Array.isArray(row.value) ? (row.value as string[]) : [];
    return (
      <MultiPickerClients
        all={clients}
        selected={selected}
        onChange={(next) => onChange({ value: next })}
      />
    );
  }
  if (row.field === "labels") {
    const selected = Array.isArray(row.value) ? (row.value as string[]) : [];
    return (
      <MultiPickerLabels
        all={labels}
        selected={selected}
        onChange={(next) => onChange({ value: next })}
      />
    );
  }

  if (row.field === "channels") {
    const selected = Array.isArray(row.value) ? (row.value as string[]) : [];
    return (
      <MultiPickerChannels
        all={channels}
        selected={selected}
        onChange={(next) => onChange({ value: next })}
      />
    );
  }

  if (row.field === "reply_since") {
    const num = typeof row.value === "number" ? row.value : 3;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm justify-between hover:bg-accent w-full"
            >
              <span>{num} Days</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          {[1, 2, 3, 4, 5, 7, 10, 14, 21, 30].map((d) => (
            <DropdownMenuItem key={d} onClick={() => onChange({ value: d })}>
              {d} Days
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (row.field === "last_message_from") {
    const value = typeof row.value === "string" ? row.value : "me";
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm justify-between hover:bg-accent w-full"
            >
              <span>{value === "me" ? "Me" : "Lead"}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onChange({ value: "me" })}>Me</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ value: "lead" })}>Lead</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (row.field === "read_status") {
    const value = typeof row.value === "string" ? row.value : "unread";
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-9 px-3 inline-flex items-center gap-2 border rounded-md bg-background text-sm justify-between hover:bg-accent w-full"
            >
              <span className="capitalize">{value}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onChange({ value: "read" })}>Read</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ value: "unread" })}>Unread</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (row.field === "message_counts") {
    const num = typeof row.value === "number" ? row.value : 1;
    return (
      <Input
        type="number"
        value={num}
        min={0}
        onChange={(e) => onChange({ value: Number(e.target.value) })}
        className="h-9"
      />
    );
  }

  // Text fields
  const text = typeof row.value === "string" ? row.value : "";
  return (
    <Input
      value={text}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="Enter value"
      className="h-9"
    />
  );
}

function MultiPickerLabels({
  all,
  selected,
  onChange,
}: {
  all: LabelRow[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  const selectedLabels = all.filter((l) => selected.includes(l.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="min-h-9 w-full px-2.5 py-1 inline-flex items-center gap-1 border rounded-md bg-background text-sm flex-wrap hover:bg-accent/30"
          >
            {selectedLabels.length === 0 ? (
              <span className="text-muted-foreground">Select labels…</span>
            ) : (
              selectedLabels.map((l) => (
                <span
                  key={l.id}
                  className="inline-flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <LabelChip name={l.name} color={l.color} />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(l.id);
                    }}
                    className="size-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
            <ChevronDown className="size-3.5 ml-auto text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-64">
        {all.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">No labels yet.</p>
        ) : (
          all.map((l) => {
            const isOn = selected.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggle(l.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-accent",
                )}
              >
                <span className={cn("size-3.5 rounded border", isOn ? "bg-foreground border-foreground" : "border-muted-foreground/40")} />
                <LabelChip name={l.name} color={l.color} />
              </button>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MultiPickerChannels({
  all,
  selected,
  onChange,
}: {
  all: ChannelRow[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  const selectedChannels = all.filter((c) => selected.includes(c.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="min-h-9 w-full px-2.5 py-1 inline-flex items-center gap-1 border rounded-md bg-background text-sm flex-wrap hover:bg-accent/30"
          >
            {selectedChannels.length === 0 ? (
              <span className="text-muted-foreground">Select channels…</span>
            ) : (
              selectedChannels.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {c.display_name ?? c.id.slice(0, 6)}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(c.id);
                    }}
                    className="size-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
            <ChevronDown className="size-3.5 ml-auto text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-64">
        {all.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">No channels yet.</p>
        ) : (
          all.map((c) => {
            const isOn = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-accent text-sm"
              >
                <span className={cn("size-3.5 rounded border", isOn ? "bg-foreground border-foreground" : "border-muted-foreground/40")} />
                <span className="truncate">{c.display_name ?? c.id.slice(0, 8)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground uppercase">
                  {c.type ?? c.provider}
                </span>
              </button>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MultiPickerCampaigns({
  all,
  selected,
  onChange,
}: {
  all: CampaignOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  const selectedCampaigns = all.filter((c) => selected.includes(c.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="min-h-9 w-full px-2.5 py-1 inline-flex items-center gap-1 border rounded-md bg-background text-sm flex-wrap hover:bg-accent/30"
          >
            {selectedCampaigns.length === 0 ? (
              <span className="text-muted-foreground">Select campaigns…</span>
            ) : (
              selectedCampaigns.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-xs max-w-[18rem]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{c.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(c.id);
                    }}
                    className="size-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
            <ChevronDown className="size-3.5 ml-auto text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-80">
        {all.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">
            No campaigns yet. Campaigns appear here as replies arrive.
          </p>
        ) : (
          all.map((c) => {
            const isOn = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-accent text-sm"
              >
                <span className={cn("size-3.5 rounded border shrink-0", isOn ? "bg-foreground border-foreground" : "border-muted-foreground/40")} />
                <span className="truncate">{c.name}</span>
                {c.source ? (
                  <span className="ml-auto text-[10px] text-muted-foreground uppercase shrink-0">
                    {c.source}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MultiPickerClients({
  all,
  selected,
  onChange,
}: {
  all: ClientOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  const selectedClients = all.filter((c) => selected.includes(c.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="min-h-9 w-full px-2.5 py-1 inline-flex items-center gap-1 border rounded-md bg-background text-sm flex-wrap hover:bg-accent/30"
          >
            {selectedClients.length === 0 ? (
              <span className="text-muted-foreground">Select clients…</span>
            ) : (
              selectedClients.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-xs max-w-[18rem]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{c.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(c.id);
                    }}
                    className="size-3.5 inline-flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))
            )}
            <ChevronDown className="size-3.5 ml-auto text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-80">
        {all.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">
            No clients yet. Clients appear here as replies arrive.
          </p>
        ) : (
          all.map((c) => {
            const isOn = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-accent text-sm"
              >
                <span className={cn("size-3.5 rounded border shrink-0", isOn ? "bg-foreground border-foreground" : "border-muted-foreground/40")} />
                <span className="truncate">{c.name}</span>
              </button>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { AtSign };
