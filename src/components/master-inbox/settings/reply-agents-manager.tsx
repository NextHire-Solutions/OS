"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Bot,
  Eye,
  EyeOff,
  Search,
  ArrowLeft,
  ArrowRight,
  Check,
} from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import { Textarea } from "@/components/mi-ui/textarea";
import { Switch } from "@/components/mi-ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import type { ReplyAgent } from "@/lib/tools/master-inbox/ai/agent";
import { cn } from "@/lib/tools/master-inbox/utils";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "vllm", label: "vLLM (self-hosted)" },
] as const;

const MODEL_OPTIONS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "gpt-5-mini", "gpt-5"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"],
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "google/gemini-2.0-flash",
  ],
  vllm: ["meta-llama/Llama-3.1-8B-Instruct"],
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "openai/gpt-4o-mini",
  vllm: "meta-llama/Llama-3.1-8B-Instruct",
};

const TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "casual", label: "Casual" },
  { value: "formal", label: "Formal" },
  { value: "persuasive", label: "Persuasive" },
  { value: "empathetic", label: "Empathetic" },
];

const LENGTH_OPTIONS: Array<{ value: Length; label: string }> = [
  { value: "short", label: "Short (1-2 sentences)" },
  { value: "medium", label: "Medium (1 paragraph)" },
  { value: "long", label: "Long (2-3 paragraphs)" },
  { value: "variable", label: "Variable (context-based)" },
];

// Token budgets — these cap the completion length. Reply drafts almost
// never need more than ~2k tokens; bigger budgets just waste credits and
// can exceed model caps (e.g. gpt-4o-mini's 16k completion limit).
const TOKEN_OPTIONS = [
  { value: 1000, label: "1k tokens (short replies)" },
  { value: 2000, label: "2k tokens (recommended)" },
  { value: 4000, label: "4k tokens (long replies)" },
  { value: 8000, label: "8k tokens (max)" },
];

type Provider = "openai" | "anthropic" | "openrouter" | "vllm";
type Length = "short" | "medium" | "long" | "variable";
type ChannelFilter = "email" | "both";

interface FormState {
  name: string;
  tone: string;
  response_length: Length;
  max_tokens: number;
  temperature: number;
  provider: Provider;
  model: string;
  api_key: string;
  system_prompt: string;
  channel_filter: ChannelFilter;
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  tone: "professional",
  response_length: "medium",
  max_tokens: 2000,
  temperature: 0.4,
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "",
  system_prompt: "",
  channel_filter: "both",
  active: true,
};

export function ReplyAgentsManager({ agents }: { agents: ReplyAgent[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReplyAgent | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setStep(1);
    setError(null);
    setShowKey(false);
    setOpen(true);
  }

  function openEdit(a: ReplyAgent) {
    setEditing(a);
    setForm({
      name: a.name,
      tone: a.tone,
      response_length: a.response_length,
      max_tokens: a.max_tokens,
      temperature: a.temperature,
      provider: a.provider,
      model: a.model,
      api_key: "",
      system_prompt: a.system_prompt ?? "",
      channel_filter: a.channel_filter,
      active: a.active,
    });
    setStep(1);
    setError(null);
    setShowKey(false);
    setOpen(true);
  }

  async function submit() {
    setError(null);
    const url = editing ? `/api/tools/master-inbox/reply-agents/${editing.id}` : "/api/tools/master-inbox/reply-agents";
    const method = editing ? "PATCH" : "POST";
    const body: Record<string, unknown> = {
      name: form.name,
      mode: "human_in_loop", // hardcoded — auto-respond intentionally removed
      tone: form.tone,
      response_length: form.response_length,
      max_tokens: form.max_tokens,
      temperature: form.temperature,
      provider: form.provider,
      model: form.model,
      system_prompt: form.system_prompt.trim() ? form.system_prompt : null,
      channel_filter: form.channel_filter,
      active: form.active,
      auto_respond_new: false,
    };
    if (form.api_key.trim()) body.api_key = form.api_key.trim();

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Save failed");
      return;
    }
    setOpen(false);
    // Reset the search filter so the new/edited agent is visible. Otherwise
    // browser autofill or a stale query can hide it until a hard refresh.
    setSearch("");
    startTransition(() => router.refresh());
  }

  async function handleDelete(a: ReplyAgent) {
    if (!confirm(`Delete reply agent "${a.name}"?`)) return;
    const res = await fetch(`/api/tools/master-inbox/reply-agents/${a.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    startTransition(() => router.refresh());
  }

  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  const canAdvance = step === 1 ? form.name.trim().length > 0 : true;

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Reply Agents</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create AI agents that automatically respond to prospect messages using full
            conversation context.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5 shrink-0">
          <Plus className="size-3.5" />
          Create Agent
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name"
          className="pl-8 h-9 text-sm"
          // Browser was autofilling the logged-in user's email into this
          // input and filtering everything out. Lock it down to prevent any
          // password-manager / address-book / browser-autocomplete writes.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          type="search"
          name="agent_search"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* Info box */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
        <p className="font-semibold text-blue-900 mb-1.5">How Reply Agents Work:</p>
        <ul className="space-y-1 text-blue-900/90">
          <li>
            <span className="font-medium">Smart Monitoring:</span> Agents monitor threads where the
            last message is from a prospect
          </li>
          <li>
            <span className="font-medium">Context Analysis:</span> Uses full conversation history
            (last 20 messages) for intelligent replies
          </li>
          <li>
            <span className="font-medium">Human-in-Loop:</span> Creates drafts for your review
            before sending
          </li>
          <li>
            <span className="font-medium">Channel Integration:</span> Works with your existing
            email channels
          </li>
        </ul>
      </div>

      {/* Empty state or agent grid */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border bg-card py-14 text-center">
          <Bot className="size-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">
            {search.trim() ? "No agents match your search." : "No agents yet"}
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Create your first AI agent to start automating email responses. Your agent will monitor
            all prospect conversations and generate contextual replies.
          </p>
          <div className="mt-4">
            <Button size="sm" onClick={openCreate} className="gap-1.5">
              <Plus className="size-3.5" />
              Create Your First Agent
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold truncate">{a.name}</p>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                        a.active
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-zinc-100 text-zinc-600",
                      )}
                    >
                      {a.active ? "Active" : "Paused"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {channelLabel(a.channel_filter)} · {a.provider} · {a.model}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEdit(a)}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    aria-label="Edit"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(a)}
                    disabled={pending}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-red-600 transition-colors"
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-y-1 text-xs">
                <span className="text-muted-foreground">Tone</span>
                <span className="capitalize">{a.tone}</span>
                <span className="text-muted-foreground">Length</span>
                <span className="capitalize">{a.response_length}</span>
                <span className="text-muted-foreground">Temperature</span>
                <span>{a.temperature.toFixed(2)}</span>
                <span className="text-muted-foreground">Max tokens</span>
                <span>{a.max_tokens.toLocaleString()}</span>
                <span className="text-muted-foreground">API key</span>
                <span className={a.has_api_key ? "text-emerald-600" : "text-amber-600"}>
                  {a.has_api_key ? "Configured" : "Not set"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 2-step wizard dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Reply Agent" : "Create New Agent"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Set up an AI agent for automated email responses
            </p>
          </DialogHeader>

          {/* Step indicator */}
          <div className="rounded-lg border bg-muted/30 px-4 py-3">
            <p className="text-xs font-semibold mb-2">
              {editing ? "Edit Agent" : "Create Agent"} – Step {step} of 2
            </p>
            <div className="flex items-center gap-3">
              <StepBadge n={1} active={step === 1} done={step > 1} label="General & Channels" hint="Agent settings and channels" />
              <div className="flex-1 h-px bg-border" />
              <StepBadge n={2} active={step === 2} done={false} label="AI Configuration" hint="AI model and behavior settings" />
            </div>
          </div>

          <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
            {step === 1 ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">
                    Agent Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g., Sales Support Agent"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Choose a descriptive name for your agent
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Tone of Voice</label>
                  <select
                    value={form.tone}
                    onChange={(e) => setForm({ ...form, tone: e.target.value })}
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {TONE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Response Length</label>
                  <select
                    value={form.response_length}
                    onChange={(e) =>
                      setForm({ ...form, response_length: e.target.value as Length })
                    }
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {LENGTH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Max tokens per reply run</label>
                  <select
                    value={form.max_tokens}
                    onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })}
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {TOKEN_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Higher budgets allow longer + more context-aware drafts.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Channel</label>
                  <select
                    value={form.channel_filter}
                    onChange={(e) =>
                      setForm({ ...form, channel_filter: e.target.value as ChannelFilter })
                    }
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="both">All channels</option>
                    <option value="email">Email only</option>
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Limits which inbound channels the agent drafts for.
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <p className="text-sm">Active</p>
                    <p className="text-[11px] text-muted-foreground">
                      Drafts are only generated when the agent is active.
                    </p>
                  </div>
                  <Switch
                    checked={form.active}
                    onCheckedChange={(v) => setForm({ ...form, active: v })}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Provider</label>
                    <select
                      value={form.provider}
                      onChange={(e) => {
                        const next = e.target.value as Provider;
                        setForm({
                          ...form,
                          provider: next,
                          model: DEFAULT_MODELS[next] ?? "",
                        });
                      }}
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Model</label>
                    <select
                      value={
                        (MODEL_OPTIONS[form.provider] ?? []).includes(form.model)
                          ? form.model
                          : "__custom__"
                      }
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setForm({ ...form, model: "" });
                        } else {
                          setForm({ ...form, model: e.target.value });
                        }
                      }}
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {(MODEL_OPTIONS[form.provider] ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                  </div>
                </div>

                {!(MODEL_OPTIONS[form.provider] ?? []).includes(form.model) ? (
                  <Input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="Custom model id"
                  />
                ) : null}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">API Key</label>
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={form.api_key}
                      onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                      placeholder={
                        editing?.has_api_key
                          ? "•••••• (saved — leave blank to keep)"
                          : "sk-…"
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted with pgcrypto. Never sent to the browser after save.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Temperature</label>
                  <Input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={form.temperature}
                    onChange={(e) =>
                      setForm({ ...form, temperature: Number(e.target.value) })
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Lower = more deterministic. 0.3-0.5 is a good range for sales replies.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Custom system prompt (optional)</label>
                  <Textarea
                    value={form.system_prompt}
                    onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                    rows={8}
                    placeholder="Leave blank to use the default sales-rep prompt"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    This is the system message the model receives on every draft. Use it to
                    inject your product/positioning context.
                  </p>
                </div>
              </>
            )}

            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </div>

          <DialogFooter className="gap-2">
            {step === 2 ? (
              <Button
                variant="outline"
                onClick={() => setStep(1)}
                className="gap-1.5 mr-auto"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)} className="mr-auto">
                Cancel
              </Button>
            )}
            {step === 1 ? (
              <Button onClick={() => setStep(2)} disabled={!canAdvance} className="gap-1.5">
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <Button onClick={submit} disabled={pending} className="gap-1.5">
                <Check className="size-3.5" />
                {editing ? "Save changes" : "Create agent"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepBadge({
  n,
  active,
  done,
  label,
  hint,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <span
        className={cn(
          "size-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors shrink-0",
          active
            ? "border-blue-500 text-blue-600 bg-blue-50"
            : done
              ? "border-emerald-500 text-emerald-600 bg-emerald-50"
              : "border-muted-foreground/30 text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0">
        <p className={cn("text-xs font-medium", active && "text-foreground")}>{label}</p>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function channelLabel(filter: ChannelFilter): string {
  if (filter === "email") return "Email";
  return "All";
}
