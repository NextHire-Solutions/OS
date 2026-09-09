// Pure type shared by server + client. No server-only imports.

export interface ChannelRow {
  id: string;
  display_name: string | null;
  provider: "emailbison" | "instantly" | null;
  type: "email" | null;
  // For Instantly channels this IS the sender email (Instantly stores
  // the address as the account id). EmailBison channels leave this
  // null — their address lives in external_account_id (when populated
  // by the auto-create at lib/sync/emailbison.ts) or is derived from
  // the latest outbound message.
  instantly_account_id: string | null;
  external_account_id: string | null;
}
