"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";

// Cancels a pending reminder on a thread + restores the thread to the inbox.
// Hits the same /snooze endpoint with { dismiss: true } so the thread's
// status flips back from 'reminder' to 'open' and the reminder row is
// marked dismissed.

export function DismissReminderButton({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function dismiss() {
    const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss: true }),
    });
    if (!res.ok) {
      toast.error("Could not dismiss reminder.");
      return;
    }
    toast.success("Moved back to inbox.");
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={dismiss}
      disabled={pending}
      aria-label="Dismiss reminder"
      title="Dismiss reminder — move thread back to inbox now"
      className="size-8 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <X className="size-4" />
    </button>
  );
}
