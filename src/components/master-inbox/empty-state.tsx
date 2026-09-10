import { Inbox, Archive, Trash2, AlertCircle } from "lucide-react";

const COPY: Record<string, { icon: typeof Inbox; title: string; body: string }> = {
  archive: {
    icon: Archive,
    title: "Nothing archived",
    body: "Threads you archive will appear here. Use the archive icon in any thread's toolbar.",
  },
  trash: {
    icon: Trash2,
    title: "Trash is empty",
    body: "Threads you delete will land here.",
  },
  spam: {
    icon: AlertCircle,
    title: "No spam",
    body: "Threads marked as spam will appear here.",
  },
};

const DEFAULT = {
  icon: Inbox,
  title: "Your inbox is empty",
  body: "Replies will appear here as soon as EmailBison delivers them.",
};

export function EmptyInbox({ view }: { view?: string }) {
  const cfg = (view && COPY[view]) || DEFAULT;
  const Icon = cfg.icon;
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="size-12 rounded-xl bg-zinc-100 mx-auto flex items-center justify-center mb-4">
          <Icon className="size-6 text-zinc-500" strokeWidth={2} />
        </div>
        <h2 className="text-base font-semibold">{cfg.title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{cfg.body}</p>
      </div>
    </div>
  );
}
