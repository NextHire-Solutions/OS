// Instant-navigation skeleton for the inbox.
//
// WHY: the inbox pages are `force-dynamic` and await ~10 loaders before
// returning any UI, and there was no loading boundary — so clicking a
// thread (or switching between threads) left the OLD page frozen on
// screen for the full server round-trip + RSC transfer + hydrate, which
// the team read as "it takes 5+ seconds to open a conversation." A
// loading.tsx that renders this skeleton makes Next paint an immediate
// response on every navigation, so the click feels instant while the
// real content streams in behind it.
//
// It only mirrors the inbox content region (the AppShell sidebar is a
// persistent parent layout and stays mounted). Heights match the real
// chrome exactly — TopBar h-12, TabBar h-12, FilterBar h-11, list rail
// w-[300px] — so there's no layout jump when the content swaps in.
function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function InboxSkeleton() {
  return (
    <>
      {/* TopBar */}
      <div className="h-12 shrink-0 border-b bg-background flex items-center px-3 gap-3">
        <Shimmer className="h-8 w-full max-w-xl" />
      </div>

      {/* TabBar */}
      <div className="h-12 shrink-0 border-b bg-background flex items-center gap-4 pl-4 pr-2">
        <Shimmer className="h-4 w-20" />
        <Shimmer className="h-4 w-24" />
        <Shimmer className="h-4 w-16" />
        <Shimmer className="h-4 w-24" />
      </div>

      {/* FilterBar */}
      <div className="h-11 shrink-0 border-b bg-background flex items-center px-3 gap-2">
        <Shimmer className="h-8 w-8" />
        <Shimmer className="h-8 w-28" />
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Thread list rail */}
        <aside className="w-[300px] shrink-0 border-r flex flex-col overflow-hidden">
          <div className="px-4 h-10 flex items-center border-b">
            <Shimmer className="h-4 w-24" />
          </div>
          <div className="flex-1 overflow-hidden px-3 py-2 space-y-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <Shimmer className="h-3.5 w-40" />
                  <Shimmer className="h-3 w-10" />
                </div>
                <Shimmer className="h-3 w-full" />
                <Shimmer className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </aside>

        {/* Message pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-10 border-b flex items-center px-4 gap-3">
            <Shimmer className="h-4 w-48" />
          </div>
          <div className="flex-1 overflow-hidden p-6 space-y-6">
            <div className="flex flex-col gap-2 max-w-[70%]">
              <Shimmer className="h-3 w-24" />
              <Shimmer className="h-16 w-full" />
            </div>
            <div className="flex flex-col gap-2 max-w-[70%] ml-auto items-end">
              <Shimmer className="h-3 w-24" />
              <Shimmer className="h-20 w-full" />
            </div>
            <div className="flex flex-col gap-2 max-w-[70%]">
              <Shimmer className="h-3 w-24" />
              <Shimmer className="h-14 w-full" />
            </div>
          </div>
        </div>

        {/* Prospect panel */}
        <aside className="w-[320px] shrink-0 border-l bg-background hidden lg:block">
          <div className="h-10 border-b flex items-center px-4">
            <Shimmer className="h-4 w-28" />
          </div>
          <div className="p-4 space-y-4">
            <Shimmer className="h-4 w-32" />
            <Shimmer className="h-3 w-full" />
            <Shimmer className="h-3 w-5/6" />
            <Shimmer className="h-3 w-2/3" />
            <div className="pt-4 space-y-3">
              <Shimmer className="h-3 w-full" />
              <Shimmer className="h-3 w-4/5" />
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
