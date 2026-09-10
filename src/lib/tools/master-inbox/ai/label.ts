// AI labeling — classifies an inbound reply into one of the workspace's
// labels. Provider-agnostic; supports OpenAI and Anthropic via raw HTTP.
//
// The prompt asks the model to pick ONE label from the supplied list (or
// reply with the literal "NONE" if nothing fits). We then look up the
// label by name and upsert a label_assignment with assigned_by='ai'.

export type AiProvider = "openai" | "anthropic" | "openrouter" | "vllm";

export interface ClassifyInput {
  provider: AiProvider;
  apiKey: string;
  model: string;
  systemPrompt: string;
  candidateLabels: string[];
  subject: string | null;
  body: string;
}

export async function classifyReply(input: ClassifyInput): Promise<string | null> {
  const userPrompt = renderUserPrompt(input);

  if (input.provider === "openai" || input.provider === "openrouter") {
    return openaiCompatible(input, userPrompt);
  }
  if (input.provider === "anthropic") {
    return anthropic(input, userPrompt);
  }
  // vLLM speaks the OpenAI-compatible API; reuse the same path.
  return openaiCompatible(input, userPrompt);
}

function renderUserPrompt(input: ClassifyInput): string {
  const truncated = (input.body ?? "").slice(0, 8000); // cap tokens roughly
  const list = input.candidateLabels.map((l) => `- ${l}`).join("\n");
  return [
    `Classify this email reply into ONE of these labels:`,
    list,
    "",
    "If none of the labels apply, respond with: NONE",
    "Respond with ONLY the label name (or NONE) — no preamble, no quotes.",
    "",
    `Subject: ${input.subject ?? "(no subject)"}`,
    "",
    "Body:",
    truncated,
  ].join("\n");
}

async function openaiCompatible(input: ClassifyInput, userPrompt: string): Promise<string | null> {
  const baseUrl =
    input.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_tokens: 32,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI provider returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content?.trim();
  return parseLabel(raw, input.candidateLabels);
}

async function anthropic(input: ClassifyInput, userPrompt: string): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 32,
      temperature: 0,
      system: input.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const raw = json.content?.find((b) => b.type === "text")?.text?.trim();
  return parseLabel(raw, input.candidateLabels);
}

function parseLabel(raw: string | undefined, candidates: string[]): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^["'`]|["'`]$/g, "").trim();
  if (cleaned.toUpperCase() === "NONE") return null;
  // Exact match wins.
  const exact = candidates.find((c) => c.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  // Otherwise, pick the first candidate that appears in the response.
  const lowered = cleaned.toLowerCase();
  return candidates.find((c) => lowered.includes(c.toLowerCase())) ?? null;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a sales-inbox triage classifier. Read an email reply from a lead and pick the single best matching label from the provided list. Lean on the lead's intent and tone:

- "Interested" → asking for next steps, scheduling, demos, more info
- "Information Request" → asking factual questions without committing
- "Meetings Booked" → confirming a meeting or proposing one
- "Not Interested" → declining or asking to stop
- "Not Right Now" → polite "later/maybe" without a commitment
- "Wrong Person" → asking to redirect or saying they're not the contact
- "Do Not Contact" → explicit unsubscribe / cease and desist
- "OOO Sequence" → auto-reply about being out of office
- "Automated Response" → bounced / no-reply / autoresponder content
- "Unable to Categorize" → ambiguous or empty content
- "Add to Blocklist" → hostile, abusive, threatening language
- "Cold-Leads" → polite but no signal of interest either way
- "Form" → form submission acknowledgement / receipt

If none of the labels fit, respond NONE.`;
