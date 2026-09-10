// Pure types shared by server + client code. No server-only imports.

export interface LabelRow {
  id: string;
  name: string;
  color: string;
  sentiment: "positive" | "negative" | "neutral";
  platform: "email" | "both";
  obligation: boolean;
  mirror_to_emailbison: boolean;
  sort_order: number;
  is_system: boolean;
}
