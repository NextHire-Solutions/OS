"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, Loader2, Mail } from "lucide-react";

interface SearchHit {
  id: string;
  subject: string | null;
  lead_full_name: string | null;
  lead_email: string | null;
  lead_company: string | null;
  last_message_at: string | null;
}

export function TopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");

  // Clearing the box (the native ✕ on type="search", or deleting the
  // text) should also drop the ?q= filter from the URL — otherwise the
  // thread list stays filtered even though the box looks empty.
  function onQueryChange(value: string) {
    setQuery(value);
    setOpen(true);
    if (value.trim() === "" && searchParams?.get("q")) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("q");
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    }
  }
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced fetch. 200ms window — feels responsive without hammering the
  // server on every keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tools/master-inbox/search/threads?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        setResults(json.results ?? []);
        setActiveIdx(0);
      } catch {
        // ignore — aborts come through here too
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [query]);

  // Click outside to close.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Cmd/Ctrl+K to focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!open) return;
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!open) return;
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = query.trim();
      if (q.length < 2) return;
      // Enter = "show every match" — render them in the normal inbox
      // thread list via ?q=, not a separate results page. (Click a
      // dropdown row to jump straight to one thread instead.)
      setOpen(false);
      router.push(`/inbox/all-email?q=${encodeURIComponent(q)}`);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showDropdown =
    open && (query.trim().length >= 2) && (loading || results.length > 0 || query.trim().length >= 2);

  return (
    <header className="h-12 shrink-0 border-b bg-background flex items-center px-3 gap-3 relative">
      <div ref={wrapperRef} className="relative flex-1 max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground animate-spin" />
        ) : null}
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search by name, email, company, or subject (⌘K)"
          className="w-full h-9 pl-9 pr-9 text-sm bg-transparent rounded-md border border-transparent hover:border-border focus:border-border focus:outline-none focus:ring-0 placeholder:text-muted-foreground transition-colors"
        />

        {showDropdown ? (
          <div className="absolute left-0 right-0 top-10 z-30 rounded-md border bg-popover shadow-lg overflow-hidden">
            {results.length === 0 && !loading ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">
                No matches for &quot;{query.trim()}&quot;.
              </div>
            ) : (
              <ul className="max-h-96 overflow-y-auto py-1">
                {results.map((hit, i) => {
                  const name = hit.lead_full_name || hit.lead_email || "Unknown";
                  return (
                    <li key={hit.id}>
                      <Link
                        href={`/inbox/all-email/${hit.id}`}
                        onClick={() => {
                          setOpen(false);
                          setQuery("");
                        }}
                        onMouseEnter={() => setActiveIdx(i)}
                        className={`flex items-center gap-3 px-3 py-2 hover:bg-accent transition-colors ${
                          i === activeIdx ? "bg-accent" : ""
                        }`}
                      >
                        <div className="size-7 rounded-md bg-zinc-100 text-zinc-700 flex items-center justify-center shrink-0">
                          <Mail className="size-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {hit.lead_email}
                            {hit.lead_company ? ` · ${hit.lead_company}` : ""}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground truncate max-w-[40%]">
                          {hit.subject ?? ""}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex-1" />
    </header>
  );
}
