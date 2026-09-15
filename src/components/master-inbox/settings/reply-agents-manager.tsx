"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ArrowLeft,
  ArrowRight,
  Check,
} from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Switch } from "@/components/mi-ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import type { ReplyAgent } from "@/lib/tools/master-inbox/ai/agent";
import {
  Btn,
  ConfirmButton,
  Field,
  Find,
  IconBtn,
  ToastHost,
  ToggleRow,
  useShowToast,
} from "./ui";

/*
 * Reply agents.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED
 *
 * The agent grid is now the design's `.card`, with a `.badge` for the state and
 * the design's key/value rhythm for the five configured values. The two-step
 * wizard keeps the shared Dialog and every field it had: name, tone, length,
 * token budget, channel, active, provider, model (preset or custom), API key,
 * temperature and the custom system prompt.
 *
 * The step indicator was a pair of Tailwind circles with hard-coded blue-500
 * and emerald-500. It is now the design's own two tones — brand blue for the
 * step you are on, the green chip background for one you have passed.
 *
 * Two behaviour changes, both in SETTINGS-PARITY.md: `window.confirm` on delete
 * becomes the arm-then-fire button, and `alert()` on a failed delete becomes
 * the screen's status line.
 */

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
  return (
    <ToastHost>
      <ReplyAgentsBody agents={agents} />
    </ToastHost>
  );
}

function ReplyAgentsBody({ agents }: { agents: ReplyAgent[] }) {
  const router = useRouter();
  const show = useShowToast();
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
    const url = editing
      ? `/api/tools/master-inbox/reply-agents/${editing.id}`
      : "/api/tools/master-inbox/reply-agents";
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
    show({ text: editing ? `Saved “${form.name}”` : `Created “${form.name}”` });
    // Reset the search filter so the new/edited agent is visible. Otherwise
    // browser autofill or a stale query can hide it until a hard refresh.
    setSearch("");
    startTransition(() => router.refresh());
  }

  async function handleDelete(a: ReplyAgent) {
    const res = await fetch(`/api/tools/master-inbox/reply-agents/${a.id}`, { method: "DELETE" });
    if (!res.ok) {
      show({ text: "Delete failed", bad: true });
      return;
    }
    show({ text: `Deleted “${a.name}”` });
    startTransition(() => router.refresh());
  }

  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  const canAdvance = step === 1 ? form.name.trim().length > 0 : true;

  return (
    <>
      <div className="mis-bar">
        <Find
          value={search}
          onChange={setSearch}
          label="Search agents by name"
          placeholder="Search agents by name"
          // The browser was autofilling the logged-in user's email into this
          // input and filtering everything out. Lock it down against every
          // password-manager / address-book / autocomplete write.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          name="agent_search"
          data-1p-ignore
          data-lpignore="true"
        />
        <span className="mis-count tnum">
          {filtered.length} of {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
        <span className="mis-gap" />
        <Btn primary onClick={openCreate} data-mis="create-agent">
          <Plus aria-hidden />
          Create agent
        </Btn>
      </div>

      {/* How they work — the design's annotation ribbon, which is exactly what
          this is: an explanation of the screen, not a warning. */}
      <div className="anno new mis-sec" style={{ margin: 0, display: "block" }}>
        <b>How reply agents work.</b>
        <ul className="mis-bullets">
          <li>
            <b>Smart monitoring:</b> agents watch threads where the last message is from a
            prospect.
          </li>
          <li>
            <b>Context analysis:</b> the last 20 messages of the conversation go into every draft.
          </li>
          <li>
            <b>Human in the loop:</b> drafts are created for your review, never sent on their own.
          </li>
          <li>
            <b>Channel integration:</b> works with the email channels you already have.
          </li>
        </ul>
      </div>

      {filtered.length === 0 ? (
        <div className="mis-sec card">
          <div className="mis-empty">
            <svg viewBox="0 0 24 24" aria-hidden>
              <rect x="3" y="8" width="18" height="12" rx="3" />
              <path d="M12 3v5M8 14h.01M16 14h.01" />
            </svg>
            <b>{search.trim() ? "No agents match your search." : "No agents yet"}</b>
            <p>
              Create your first AI agent to start drafting email responses. It will watch prospect
              conversations and write a contextual reply for you to review.
            </p>
            <Btn primary onClick={openCreate}>
              Create your first agent
            </Btn>
          </div>
        </div>
      ) : (
        <div className="mis-cards mis-sec">
          {filtered.map((a) => (
            <div key={a.id} className="card" data-mis-agent={a.name}>
              <div className="mis-card-h">
                <div className="mis-row-m">
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
                  >
                    <span className="mis-row-n mis-trunc">{a.name}</span>
                    <span className={`badge ${a.active ? "s-done" : "s-pending"}`}>
                      <span className="dot" />
                      {a.active ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div className="mis-row-s mis-trunc">
                    {channelLabel(a.channel_filter)} · {a.provider} · {a.model}
                  </div>
                </div>
                <div className="mis-row-a">
                  <IconBtn label={`Edit ${a.name}`} onClick={() => openEdit(a)}>
                    <Pencil aria-hidden />
                  </IconBtn>
                  <ConfirmButton
                    compact
                    label="Delete"
                    armedLabel="Confirm delete"
                    title={`Delete reply agent “${a.name}”? Drafts it has already written stay where they are.`}
                    disabled={pending}
                    onConfirm={() => void handleDelete(a)}
                  >
                    <Trash2 aria-hidden />
                  </ConfirmButton>
                </div>
              </div>
              <dl className="mis-kv">
                <dt>Tone</dt>
                <dd className="mis-cap">{a.tone}</dd>
                <dt>Length</dt>
                <dd className="mis-cap">{a.response_length}</dd>
                <dt>Temperature</dt>
                <dd>{a.temperature.toFixed(2)}</dd>
                <dt>Max tokens</dt>
                <dd>{a.max_tokens.toLocaleString("en-US")}</dd>
                <dt>API key</dt>
                <dd style={{ color: a.has_api_key ? "var(--green)" : "var(--amber)" }}>
                  {a.has_api_key ? "Configured" : "Not set"}
                </dd>
              </dl>
            </div>
          ))}
        </div>
      )}

      {/* 2-step wizard dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent style={{ maxWidth: "min(700px, calc(100vw - 2rem))" }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit reply agent" : "Create new agent"}</DialogTitle>
            <p className="mis-sub" style={{ marginTop: 2 }}>
              Set up an AI agent for drafted email responses — step {step} of 2.
            </p>
          </DialogHeader>

          <div className="mis-steps">
            <div className={`mis-step${step === 1 ? " on" : " done"}`}>
              <i>{step > 1 ? <Check aria-hidden style={{ width: 14, height: 14 }} /> : 1}</i>
              <div style={{ minWidth: 0 }}>
                <b>General &amp; channels</b>
                <span>Agent settings and channels</span>
              </div>
            </div>
            <span className="mis-step-line" />
            <div className={`mis-step${step === 2 ? " on" : ""}`}>
              <i>2</i>
              <div style={{ minWidth: 0 }}>
                <b>AI configuration</b>
                <span>Model and behaviour</span>
              </div>
            </div>
          </div>

          <div className="mis-form mis-scroll">
            {step === 1 ? (
              <>
                <Field
                  label="Agent name"
                  required
                  hint="Choose a descriptive name for your agent."
                >
                  <input
                    className="inp"
                    aria-label="Agent name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Sales Support Agent"
                  />
                </Field>

                <div className="mis-g mis-g2">
                  <Field label="Tone of voice">
                    <select
                      className="sel"
                      aria-label="Tone of voice"
                      value={form.tone}
                      onChange={(e) => setForm({ ...form, tone: e.target.value })}
                    >
                      {TONE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Response length">
                    <select
                      className="sel"
                      aria-label="Response length"
                      value={form.response_length}
                      onChange={(e) =>
                        setForm({ ...form, response_length: e.target.value as Length })
                      }
                    >
                      {LENGTH_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field
                  label="Max tokens per reply run"
                  hint="Higher budgets allow longer, more context-aware drafts."
                >
                  <select
                    className="sel"
                    aria-label="Max tokens per reply run"
                    value={form.max_tokens}
                    onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })}
                  >
                    {TOKEN_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Channel" hint="Limits which inbound channels the agent drafts for.">
                  <select
                    className="sel"
                    aria-label="Channel"
                    value={form.channel_filter}
                    onChange={(e) =>
                      setForm({ ...form, channel_filter: e.target.value as ChannelFilter })
                    }
                  >
                    <option value="both">All channels</option>
                    <option value="email">Email only</option>
                  </select>
                </Field>

                <ToggleRow
                  title="Active"
                  hint="Drafts are only generated while the agent is active."
                >
                  <Switch
                    checked={form.active}
                    aria-label="Active"
                    onCheckedChange={(v) => setForm({ ...form, active: v })}
                  />
                </ToggleRow>
              </>
            ) : (
              <>
                <div className="mis-g mis-g2">
                  <Field label="Provider">
                    <select
                      className="sel"
                      aria-label="Provider"
                      value={form.provider}
                      onChange={(e) => {
                        const next = e.target.value as Provider;
                        setForm({ ...form, provider: next, model: DEFAULT_MODELS[next] ?? "" });
                      }}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Model">
                    <select
                      className="sel"
                      aria-label="Model"
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
                    >
                      {(MODEL_OPTIONS[form.provider] ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                  </Field>
                </div>

                {!(MODEL_OPTIONS[form.provider] ?? []).includes(form.model) ? (
                  <Field label="Custom model id">
                    <input
                      className="inp"
                      aria-label="Custom model id"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                      placeholder="Custom model id"
                    />
                  </Field>
                ) : null}

                <Field
                  label="API key"
                  hint="Stored encrypted with pgcrypto. Never sent to the browser after save."
                >
                  <div className="mis-inline">
                    <div className="mis-reveal">
                      <input
                        className="inp"
                        aria-label="Agent API key"
                        type={showKey ? "text" : "password"}
                        value={form.api_key}
                        onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                        placeholder={
                          editing?.has_api_key ? "•••••• (saved — leave blank to keep)" : "sk-…"
                        }
                      />
                      <IconBtn
                        label={showKey ? "Hide key" : "Show key"}
                        onClick={() => setShowKey((v) => !v)}
                      >
                        {showKey ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                      </IconBtn>
                    </div>
                  </div>
                </Field>

                <Field
                  label="Temperature"
                  hint="Lower is more deterministic. 0.3–0.5 is a good range for sales replies."
                >
                  <input
                    className="inp"
                    aria-label="Temperature"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={form.temperature}
                    onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
                  />
                </Field>

                <Field
                  label="Custom system prompt"
                  optional="(optional)"
                  hint="The system message the model receives on every draft. Use it to inject your product and positioning context."
                >
                  <textarea
                    className="inp"
                    aria-label="Custom system prompt"
                    value={form.system_prompt}
                    onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                    rows={8}
                    style={{ minHeight: 150 }}
                    placeholder="Leave blank to use the default sales-rep prompt"
                  />
                </Field>
              </>
            )}

            {error ? (
              <p className="mis-err" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            {step === 2 ? (
              <Button variant="outline" onClick={() => setStep(1)} style={{ marginRight: "auto" }}>
                <ArrowLeft aria-hidden style={{ width: 14, height: 14, marginRight: 6 }} />
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)} style={{ marginRight: "auto" }}>
                Cancel
              </Button>
            )}
            {step === 1 ? (
              <Button onClick={() => setStep(2)} disabled={!canAdvance} data-mis="agent-next">
                Next
                <ArrowRight aria-hidden style={{ width: 14, height: 14, marginLeft: 6 }} />
              </Button>
            ) : (
              <Button onClick={submit} disabled={pending} data-mis="agent-save">
                {editing ? "Save changes" : "Create agent"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function channelLabel(filter: ChannelFilter): string {
  if (filter === "email") return "Email";
  return "All";
}
