import "server-only";

/*
 * The assistant reads. It does not write. This is what enforces that.
 *
 * ---------------------------------------------------------------------------
 * WHY A GUARD RATHER THAN A CONVENTION
 *
 * Answering "which client is performing badly" needs service-role connections
 * to all four products — Master Inbox, Analytics, Client Health, Agent Search.
 * A service-role key can write to every table it can read, and three of those
 * databases are live systems that clients are using right now: Master Inbox
 * serves 47 login-free customer portals, Analytics drives real send schedules.
 *
 * Nothing in the assistant needs to write to any of them. But "nothing needs
 * to" is a fact about today's ten tools, not a property of the code — and the
 * eleventh tool gets written by someone in a hurry. So the capability is taken
 * away here instead of being left to discipline.
 *
 * This is the same reasoning as the OS_TABLES allowlist (src/lib/clients/
 * os-tables.ts): the stakes are a customer's portal, so the policy is a
 * separate, testable object rather than a rule people remember.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ACTUALLY STOPS
 *
 * A Supabase query builder exposes insert/update/upsert/delete on the same
 * object as select. This proxies the client so those four names throw on
 * access — before a request is ever built, so there is no window where a
 * half-formed write exists. `rpc` is allowed because several products expose
 * their aggregates as functions (analytics_campaign_rows and friends), but a
 * name on the write list is refused there too.
 */

/** Refused outright: the query-builder verbs that change rows. */
const FORBIDDEN_VERBS = ["insert", "update", "upsert", "delete"] as const;

/*
 * Functions that write, refused by name.
 *
 * The products expose read aggregates AND a handful of mutating functions
 * through the same rpc() door, so the door alone is not the boundary. These
 * are matched on a prefix because the families are named consistently:
 * `reply_agent_set_key`, `ai_labeling_set_key`, `fn_undo_agent_contact`.
 */
const FORBIDDEN_RPC = [/_set_key$/, /^fn_undo_/, /_touch_run$/, /^fn_refresh_/, /^fn_export_/];

export class AssistantWriteAttemptError extends Error {
  constructor(what: string) {
    super(
      `The assistant tried to ${what}, and the assistant is read-only. ` +
        `It answers questions across four live products — Master Inbox serves ` +
        `customer portals — so a tool may only read. If a write is genuinely ` +
        `wanted, it belongs in that product's own API with its own confirmation, ` +
        `never behind a chat message. See src/lib/tools/assistant/read-only.ts.`,
    );
    this.name = "AssistantWriteAttemptError";
  }
}

export function isForbiddenRpc(name: string): boolean {
  return FORBIDDEN_RPC.some((pattern) => pattern.test(name));
}

export function isForbiddenVerb(name: string): boolean {
  return (FORBIDDEN_VERBS as readonly string[]).includes(name);
}

/**
 * Wraps a Supabase client so only reads survive.
 *
 * Typed as the client it wraps: every call site keeps its types, and the
 * removal is a runtime property. A compile-time-only restriction would be
 * erased by a single `as any`, which is exactly the shortcut a hurried change
 * reaches for.
 */
export function readOnly<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const name = String(prop);

      if (isForbiddenVerb(name)) {
        throw new AssistantWriteAttemptError(`call .${name}()`);
      }

      const value = Reflect.get(target, prop, receiver);

      if (name === "rpc" && typeof value === "function") {
        return (fn: string, ...rest: unknown[]) => {
          if (isForbiddenRpc(fn)) throw new AssistantWriteAttemptError(`call the ${fn} function`);
          return (value as (...a: unknown[]) => unknown).call(target, fn, ...rest);
        };
      }

      /*
       * `from()` returns a NEW builder carrying its own insert/update/delete,
       * so guarding the client alone would leave the write verbs one hop away.
       * The builder is wrapped with the same proxy, and so is whatever its
       * chained methods return — .select().eq().order() each hand back a
       * builder, and any of them would otherwise be an unguarded way in.
       */
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result && typeof result === "object" ? readOnly(result as object) : result;
        };
      }

      return value;
    },
  });
}
