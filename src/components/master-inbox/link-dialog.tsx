"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";

// Modal for inserting / editing a hyperlink in either rich-text editor
// (composer body OR template body). Replaces the native window.prompt
// flow with a proper two-field form: the visible text + the URL.
//
// open / onOpenChange — controlled state from the parent
// initialText / initialUrl — pre-fill values; pass "" when inserting a
//   fresh link.
// onSubmit({ text, url }) — fired when the user clicks Save. The
//   parent runs the actual editor command.
// onRemove — when present, the dialog shows a "Remove link" button
//   that calls this and closes (used when the caret is INSIDE an
//   existing link).

export function LinkDialog({
  open,
  onOpenChange,
  initialText,
  initialUrl,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  initialUrl: string;
  onSubmit: (next: { text: string; url: string }) => void;
  onRemove?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Reset state whenever the dialog opens with fresh values. Without
  // this, a second open with different initial values would re-show
  // the prior input.
  useEffect(() => {
    if (open) {
      setText(initialText);
      setUrl(initialUrl);
    }
  }, [open, initialText, initialUrl]);

  function save() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      // Empty URL → treat as "remove link" if we're editing.
      if (onRemove) onRemove();
      onOpenChange(false);
      return;
    }
    // Auto-prefix bare domains with https:// so users don't have to
    // type it. Skip the prefix for mailto:, tel:, etc.
    const looksLikeProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl);
    const finalUrl = looksLikeProtocol ? trimmedUrl : `https://${trimmedUrl}`;
    const finalText = text.trim().length > 0 ? text.trim() : finalUrl;
    onSubmit({ text: finalText, url: finalUrl });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initialUrl ? "Edit link" : "Insert link"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="link-text">
              Text to display
            </label>
            <Input
              id="link-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. our website"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="link-url">
              Link URL
            </label>
            <Input
              ref={urlInputRef}
              id="link-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="text-[10.5px] text-muted-foreground">
              We&apos;ll add <code className="font-mono">https://</code>{" "}
              automatically if you leave it off.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onRemove();
                  onOpenChange(false);
                }}
                className="mr-auto text-red-600 hover:text-red-700 gap-1.5"
              >
                <Trash2 className="size-3.5" />
                Remove link
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!url.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
