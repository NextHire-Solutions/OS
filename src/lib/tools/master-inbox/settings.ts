import "server-only";

import { getMasterInboxSupabase, workspaceId } from "./supabase";

/*
 * Master Inbox — settings.
 *
 * Eight screens in the tool; this reads what they show. Read-only for now, and
 * that is the honest state rather than a placeholder: every one of these is an
 * editor, and the editors are worth doing properly rather than quickly.
 *
 * Two of them carry a secret and must never leak it:
 *
 *   reply_agents.api_key_encrypted — an encrypted provider key
 *   clients.fub_api_key            — the client's Follow Up Boss key
 *
 * Neither column is selected below. The tool's own portal loader takes the
 * same care, reducing the FUB key to a boolean before it leaves the server,
 * and this does the same: the screen needs to know a key EXISTS, never what
 * it is.
 */

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface SettingsLabel {
  id: string;
  name: string;
  color: string | null;
  sentiment: string | null;
  /** How many threads currently carry it. */
  threads: number;
}

export interface SettingsTemplate {
  id: string;
  name: string;
  category: string | null;
  subject: string | null;
  preview: string;
  updatedAt: string | null;
}

export interface SettingsAgent {
  id: string;
  name: string;
  mode: string | null;
  model: string | null;
  provider: string | null;
  active: boolean;
  autoRespond: boolean;
  /** Whether a provider key is stored — never the key itself. */
  hasKey: boolean;
}

export interface SettingsMember {
  userId: string;
  role: string | null;
  status: string | null;
}

export interface SettingsView {
  id: string;
  name: string;
  slug: string;
}

export interface MasterInboxSettings {
  labels: SettingsLabel[];
  templates: SettingsTemplate[];
  agents: SettingsAgent[];
  members: SettingsMember[];
  views: SettingsView[];
  clients: number;
  error: string | null;
}

/** Plain text from a template body, for a one-line preview. */
function preview(body: unknown, html: unknown): string {
  const text = str(body);
  if (text) return text.replace(/\s+/g, " ").slice(0, 120);
  const markup = str(html);
  if (!markup) return "";
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function getSettings(): Promise<MasterInboxSettings> {
  const empty: MasterInboxSettings = {
    labels: [], templates: [], agents: [], members: [], views: [], clients: 0, error: null,
  };

  try {
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();

    const [labels, templates, agents, members, views, clients, assignments] = await Promise.all([
      sb.from("labels").select("id,name,color,sentiment").eq("workspace_id", ws).order("name"),
      sb.from("reply_templates")
        .select("id,name,category,subject,body,body_html,updated_at")
        .eq("workspace_id", ws).order("sort_order", { nullsFirst: false }).limit(200),
      // api_key_encrypted is deliberately not selected.
      sb.from("reply_agents")
        .select("id,name,mode,model,provider,active,auto_respond_new,api_key_encrypted")
        .eq("workspace_id", ws).order("name"),
      sb.from("workspace_members").select("user_id,role,status").eq("workspace_id", ws),
      sb.from("custom_views").select("id,name,slug").eq("workspace_id", ws).order("name"),
      sb.from("clients").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
      // One read for every label's thread count, rather than one per label.
      sb.from("label_assignments").select("label_id").eq("target_type", "thread").limit(20_000),
    ]);

    if (labels.error) throw new Error(labels.error.message);

    const perLabel = new Map<string, number>();
    for (const a of rows(assignments.data)) {
      const id = str(a.label_id);
      if (id) perLabel.set(id, (perLabel.get(id) ?? 0) + 1);
    }

    return {
      labels: rows(labels.data).map((l) => ({
        id: String(l.id),
        name: String(l.name ?? ""),
        color: str(l.color),
        sentiment: str(l.sentiment),
        threads: perLabel.get(String(l.id)) ?? 0,
      })),
      templates: rows(templates.data).map((t) => ({
        id: String(t.id),
        name: String(t.name ?? "Untitled"),
        category: str(t.category),
        subject: str(t.subject),
        preview: preview(t.body, t.body_html),
        updatedAt: str(t.updated_at),
      })),
      agents: rows(agents.data).map((a) => ({
        id: String(a.id),
        name: String(a.name ?? "Unnamed"),
        mode: str(a.mode),
        model: str(a.model),
        provider: str(a.provider),
        active: a.active === true,
        autoRespond: a.auto_respond_new === true,
        // Reduced to a boolean here, on the server. The key never travels.
        hasKey: typeof a.api_key_encrypted === "string" && a.api_key_encrypted.length > 0,
      })),
      members: rows(members.data).map((m) => ({
        userId: String(m.user_id),
        role: str(m.role),
        status: str(m.status),
      })),
      views: rows(views.data).map((v) => ({
        id: String(v.id),
        name: String(v.name ?? ""),
        slug: String(v.slug ?? ""),
      })),
      clients: num(clients.count) ?? 0,
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : "Settings could not be read",
    };
  }
}
