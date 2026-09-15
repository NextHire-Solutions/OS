"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Switch } from "@/components/mi-ui/switch";
import { fullStamp } from "@/lib/workspace/dates";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import {
  Btn,
  Chip,
  ConfirmButton,
  Field,
  IconBtn,
  Section,
  ToastHost,
  ToggleRow,
} from "./ui";

/*
 * AI labelling.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED
 *
 * Four Tailwind boxes become four of the design's cards; the switch rows become
 * the design's recessed groups; the candidate labels become the same chips the
 * inbox draws, dimmed when off; the progress bar becomes the design's `.track`.
 * The streaming NDJSON reader, every config field, the model picker's two modes
 * and the whole run report are the code that was already here.
 *
 * ---------------------------------------------------------------------------
 * THREE FIXES
 *
 *   · `Clear` and `Run on historical replies` were guarded by `window.confirm`.
 *     Both spend real money or destroy a saved secret, so the guard matters —
 *     but a native modal suspends the page and cannot be driven, which means
 *     neither control could ever be proven to work. Both are arm-then-fire now,
 *     carrying the same warning in their titles.
 *
 *   · "Last run" was `new Date(...).toLocaleString(...)` written out inline. It
 *     pinned the zone, so it was not the hydration bug this repo has shipped
 *     three times — but it was one edit away from being it. It goes through
 *     `lib/workspace/dates.ts` like every other stamp in the workspace.
 *
 *   · The candidate-label chips were `<button>` wrappers with no pressed state,
 *     so "on" and "off" were conveyed by opacity alone — invisible to a screen
 *     reader and to a test. They carry `aria-pressed` now, and the stylesheet
 *     keys the dimming off it.
 */

interface BackfillReport {
  scanned: number;
  labeled: number;
  no_inbound: number;
  skipped_already_labeled: number;
  skipped_disabled: number;
  skipped_no_key: number;
  skipped_no_config: number;
  skipped_no_labels: number;
  skipped_model_returned_none: number;
  skipped_no_match: number;
  errors: number;
  sample_labels: Array<{ thread_id: string; label: string }>;
  sample_errors: Array<{ thread_id: string; error: string }>;
}

interface BackfillProgress {
  scanned: number;
  total: number;
  labeled: number;
  no_inbound: number;
  skipped_already_labeled: number;
  skipped_no_match: number;
  skipped_model_returned_none: number;
  errors: number;
}

interface ServerConfig {
  enabled: boolean;
  provider: "openai" | "anthropic" | "openrouter" | "vllm";
  has_api_key: boolean;
  model: string;
  label_old_replies: boolean;
  relabel_ongoing: boolean;
  use_custom_prompt: boolean;
  custom_prompt: string | null;
  category_set: string[];
  last_run_at: string | null;
}

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
    "meta-llama/llama-3.1-70b-instruct",
  ],
  vllm: ["meta-llama/Llama-3.1-8B-Instruct"],
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "openai/gpt-4o-mini",
  vllm: "meta-llama/Llama-3.1-8B-Instruct",
};

export function AiLabelingForm(props: { initial: ServerConfig | null; labels: LabelRow[] }) {
  return (
    <ToastHost>
      <AiLabelingBody {...props} />
    </ToastHost>
  );
}

function AiLabelingBody({
  initial,
  labels,
}: {
  initial: ServerConfig | null;
  labels: LabelRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [provider, setProvider] = useState<ServerConfig["provider"]>(initial?.provider ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODELS.openai);
  const [labelOld, setLabelOld] = useState(initial?.label_old_replies ?? false);
  const [relabel, setRelabel] = useState(initial?.relabel_ongoing ?? false);
  const [useCustomPrompt, setUseCustomPrompt] = useState(initial?.use_custom_prompt ?? false);
  const [customPrompt, setCustomPrompt] = useState(initial?.custom_prompt ?? "");
  const [categorySet, setCategorySet] = useState<string[]>(initial?.category_set ?? []);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [runReport, setRunReport] = useState<BackfillReport | null>(null);

  function toggleCategory(name: string) {
    setCategorySet((cur) =>
      cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name],
    );
  }

  async function save() {
    setError(null);
    setMessage(null);
    const body: Record<string, unknown> = {
      enabled,
      provider,
      model,
      label_old_replies: labelOld,
      relabel_ongoing: relabel,
      use_custom_prompt: useCustomPrompt,
      custom_prompt: useCustomPrompt ? customPrompt : null,
      category_set: categorySet,
    };
    if (apiKey.trim().length > 0) body.api_key = apiKey.trim();

    const res = await fetch("/api/tools/master-inbox/ai-labeling", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Save failed");
      return;
    }
    setApiKey("");
    setMessage("Saved.");
    startTransition(() => router.refresh());
  }

  async function clearKey() {
    setError(null);
    setMessage(null);
    const res = await fetch("/api/tools/master-inbox/ai-labeling", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "" }),
    });
    if (!res.ok) {
      setError("Clear failed");
      return;
    }
    setMessage("API key cleared.");
    startTransition(() => router.refresh());
  }

  async function runBackfill() {
    setError(null);
    setMessage(null);
    setRunReport(null);
    setProgress(null);
    setRunning(true);
    try {
      const res = await fetch("/api/tools/master-inbox/ai-labeling/run", { method: "POST" });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        setError(txt || `Run failed (${res.status})`);
        return;
      }
      // Stream is newline-delimited JSON, one event per line. Buffer
      // partial chunks because TCP doesn't promise line-aligned reads.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (!line) continue;
          let event: { type: string; [k: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "progress") {
            setProgress(event as unknown as BackfillProgress);
          } else if (event.type === "done") {
            const { type: _t, ...rest } = event;
            void _t;
            setRunReport(rest as unknown as BackfillReport);
            startTransition(() => router.refresh());
          } else if (event.type === "error") {
            setError((event.error as string) ?? "Run failed");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Section
        title="Provider"
        sub="When a new inbound reply arrives, the model picks one of your labels for it."
      >
        <ToggleRow
          title="Enable AI labelling"
          hint="Off, replies arrive untagged and wait for a reply manager."
        >
          <Switch checked={enabled} aria-label="Enable AI labelling" onCheckedChange={setEnabled} />
        </ToggleRow>

        <div className="mis-g mis-g2" style={{ marginTop: 16 }}>
          <Field label="Provider">
            <select
              className="sel"
              aria-label="Provider"
              value={provider}
              onChange={(e) => {
                const next = e.target.value as ServerConfig["provider"];
                setProvider(next);
                // Bump model to a sensible default for the new provider.
                setModel(DEFAULT_MODELS[next] ?? "");
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="mis-f">
            <span className="mis-l">Model</span>
            <ModelPicker provider={provider} value={model} onChange={setModel} />
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <Field
            label="API key"
            hint="Stored encrypted with pgcrypto. Never sent to the browser after save."
          >
            <div className="mis-inline">
              <div className="mis-reveal">
                <input
                  className="inp"
                  aria-label="AI provider API key"
                  // Browser password managers were auto-filling this slot with
                  // the user's login password (because of type=password + the
                  // page being inside the app shell). The readOnly-until-focus
                  // trick is the only reliable way to block that — the autofill
                  // heuristic can't target a readonly field at mount time.
                  type={showKey ? "text" : "password"}
                  name="ai-provider-key"
                  autoComplete="off"
                  aria-autocomplete="none"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  readOnly
                  onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    initial?.has_api_key ? "•••••••• (saved — leave blank to keep)" : "sk-…"
                  }
                />
                <IconBtn
                  label={showKey ? "Hide key" : "Show key"}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                </IconBtn>
              </div>
              {initial?.has_api_key ? (
                <ConfirmButton
                  label="Clear"
                  armedLabel="Confirm clear"
                  title="Clear the saved API key? Labelling stops until a new one is saved."
                  disabled={pending}
                  onConfirm={() => void clearKey()}
                />
              ) : null}
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Behaviour">
        <ToggleRow
          title="Re-label ongoing replies"
          hint="If a new inbound arrives on a thread that is already AI-labelled, replace the label with the latest classification."
        >
          <Switch
            checked={relabel}
            aria-label="Re-label ongoing replies"
            onCheckedChange={setRelabel}
          />
        </ToggleRow>
        <ToggleRow
          title="Include in historical backfill"
          hint="When you run on historical replies, include threads created before AI was enabled."
        >
          <Switch
            checked={labelOld}
            aria-label="Include in historical backfill"
            onCheckedChange={setLabelOld}
          />
        </ToggleRow>
      </Section>

      <Section
        title="Candidate labels"
        sub="The model may only pick a label that is turned on. Click a chip to toggle it."
        action={
          <span className="mis-count tnum">
            {categorySet.length} / {labels.length} on
          </span>
        }
      >
        <div className="mis-chips">
          {labels.map((l) => {
            const selected = categorySet.includes(l.name);
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleCategory(l.name)}
                title={
                  selected
                    ? `On — AI may apply “${l.name}”`
                    : `Off — AI will never apply “${l.name}”`
                }
              >
                <Chip name={l.name} color={l.color} />
              </button>
            );
          })}
        </div>

        <div className="anno" style={{ margin: "16px 0 0", display: "block" }}>
          <p>
            <b>Turned off.</b> A dimmed label above is never applied by the AI to a new reply.
            Existing assignments stay on the conversations they are already on.
          </p>
          <p style={{ marginTop: 6 }}>
            <b>No match.</b> When the AI cannot confidently pick any of the turned-on labels, the
            conversation stays untagged and surfaces in <b>Open Responses</b> so a reply manager
            can categorise it by hand.
          </p>
        </div>
      </Section>

      <Section
        title="Custom system prompt"
        sub="Override the default classification prompt to tune it for your industry or rules."
      >
        <ToggleRow title="Use a custom prompt" hint="Off, the built-in triage prompt is used.">
          <Switch
            checked={useCustomPrompt}
            aria-label="Use a custom prompt"
            onCheckedChange={setUseCustomPrompt}
          />
        </ToggleRow>
        {useCustomPrompt ? (
          <textarea
            className="inp"
            aria-label="Custom system prompt"
            style={{ width: "100%", marginTop: 14, minHeight: 160 }}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            rows={8}
            placeholder="You are a sales-inbox triage classifier…"
          />
        ) : null}
      </Section>

      {running && progress ? <ProgressBar progress={progress} /> : null}
      {runReport ? <RunReportCard report={runReport} /> : null}

      <div className="mis-act">
        <ConfirmButton
          label={running ? "Running…" : "Run on historical replies"}
          armedLabel="Confirm — spend API credits"
          title="Run AI labelling on every open thread. This uses your API credits."
          disabled={running || pending || !initial?.has_api_key}
          onConfirm={() => void runBackfill()}
        />
        <span className="mis-gap" />
        {error ? (
          <span className="mis-err" role="alert">
            {error}
          </span>
        ) : null}
        {message ? (
          <span className="mis-ok" role="status">
            {message}
          </span>
        ) : null}
        {initial?.last_run_at ? (
          <span className="mis-stamp">Last run {fullStamp(initial.last_run_at)}</span>
        ) : null}
        <Btn primary onClick={save} disabled={pending} data-mis="save-ai">
          Save
        </Btn>
      </div>
    </>
  );
}

function RunReportCard({ report }: { report: BackfillReport }) {
  const skipRows: Array<{ label: string; value: number; hint?: string }> = [
    {
      label: "Already labelled (and re-label is off)",
      value: report.skipped_already_labeled,
      hint: "Turn on “Re-label ongoing replies” to overwrite these.",
    },
    {
      label: "No inbound message on thread",
      value: report.no_inbound,
      hint: "The thread had only outbound messages — nothing to classify.",
    },
    {
      label: "Model returned NONE",
      value: report.skipped_model_returned_none,
      hint: "The prompt was too strict for the reply, or the reply was empty / system noise.",
    },
    {
      label: "Model returned a name not in your labels",
      value: report.skipped_no_match,
      hint: "Tighten the candidate list, or refine the prompt to use exact names.",
    },
    {
      label: "AI labelling disabled",
      value: report.skipped_disabled,
      hint: "Run-on-webhook is off. The backfill ran in force mode anyway, so this should be 0.",
    },
    { label: "No API key configured", value: report.skipped_no_key },
    { label: "No AI config row", value: report.skipped_no_config },
    { label: "No labels in workspace", value: report.skipped_no_labels },
    { label: "Errors", value: report.errors },
  ].filter((r) => r.value > 0);

  return (
    <Section
      title="Run report"
      action={
        <span className="mis-count tnum">
          {report.labeled} labelled · {report.scanned} scanned
        </span>
      }
    >
      <div className="mis-report">
        {report.sample_labels.length > 0 ? (
          <div>
            <div className="mis-l">Sample classifications</div>
            <div className="mis-report-l">
              {report.sample_labels.map((s) => (
                <div key={s.thread_id}>
                  <span className="mis-mono">{s.thread_id.slice(0, 8)}</span>
                  <span>→ {s.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {skipRows.length > 0 ? (
          <div>
            <div className="mis-l">Why some were not labelled</div>
            <div className="mis-report-l">
              {skipRows.map((r) => (
                <div key={r.label}>
                  <span className="mis-num">{r.value}</span>
                  <div>
                    <div style={{ color: "var(--ink-2)" }}>{r.label}</div>
                    {r.hint ? <div className="mut">{r.hint}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {report.sample_errors.length > 0 ? (
          <div>
            <div className="mis-l">Sample errors</div>
            <div className="mis-report-l">
              {report.sample_errors.map((s, i) => (
                <div key={i} style={{ color: "var(--red)" }}>
                  <span className="mis-mono">{s.thread_id.slice(0, 8)}</span>
                  <span>{s.error}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ProgressBar({ progress }: { progress: BackfillProgress }) {
  const { scanned, total, labeled, errors } = progress;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  const remaining = Math.max(0, total - scanned);
  return (
    <Section>
      <div className="mis-prog-h">
        <b>
          Labelling threads… <span className="tnum">{scanned}</span> /{" "}
          <span className="tnum">{total}</span>
        </b>
        <span>{pct}%</span>
      </div>
      {/* The design's own meter — `.track` with a single blue fill. */}
      <div
        className="track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Backfill progress"
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="mis-prog-f">
        <span>
          <b>{labeled}</b> labelled
        </span>
        <span>
          <b>{remaining}</b> remaining
        </span>
        {errors > 0 ? (
          <span className="mis-bad">
            <b>{errors}</b> errors
          </span>
        ) : null}
      </div>
    </Section>
  );
}

/*
 * Two-mode model picker: a dropdown of presets per provider, plus a "Custom…"
 * option that reveals a free-text input for newer or unlisted models.
 */
function ModelPicker({
  provider,
  value,
  onChange,
}: {
  provider: "openai" | "anthropic" | "openrouter" | "vllm";
  value: string;
  onChange: (v: string) => void;
}) {
  const presets = MODEL_OPTIONS[provider] ?? [];
  const isCustom = !presets.includes(value);
  const [mode, setMode] = useState<"preset" | "custom">(isCustom ? "custom" : "preset");
  const box = useRef<HTMLInputElement | null>(null);
  /*
   * Focus on the TRANSITION, never on mount.
   *
   * This was `autoFocus`, which is subtly wrong here. Unlike the three other
   * autofocused fields on these panels, this one is NOT dialog-only markup: it
   * renders on the server whenever the saved model is not a preset for the
   * saved provider, which is precisely what choosing "Custom…" and saving
   * leaves behind. So for any workspace running a custom model id, merely
   * opening this tab yanked the caret into a text box and scrolled the page to
   * it — every time.
   *
   * Choosing "Custom…" should put the caret in the box. Arriving at a page that
   * happens to have a custom model saved should not.
   *
   * (It was also suspected of causing a hydration mismatch, on the reasoning
   * that React serialises `autoFocus` into the SSR HTML and applies it as a
   * property on the client. That was checked rather than assumed —
   * `scripts/settings-probe.mjs --hydration-ai-custom` puts the config into
   * exactly that state and loads the page — and React 19 does not warn. The
   * probe stays, because it is the only way to reach this branch from a test.)
   */
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (mode === "custom") box.current?.focus();
  }, [mode]);

  if (mode === "custom") {
    return (
      <div className="mis-inline">
        <input
          ref={box}
          className="inp"
          aria-label="Custom model id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model-id"
        />
        <Btn
          onClick={() => {
            setMode("preset");
            onChange(presets[0] ?? "");
          }}
        >
          Use preset
        </Btn>
      </div>
    );
  }

  return (
    <select
      className="sel"
      aria-label="Model"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "__custom__") {
          setMode("custom");
          onChange("");
        } else {
          onChange(v);
        }
      }}
    >
      {presets.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value="__custom__">Custom…</option>
    </select>
  );
}
