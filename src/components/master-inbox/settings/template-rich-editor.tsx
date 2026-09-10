"use client";

import { useEffect, useState } from "react";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  Heading2,
  Link as LinkIcon,
  ChevronDown,
} from "lucide-react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@/lib/tools/master-inbox/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { TEMPLATE_VARIABLES } from "@/lib/tools/master-inbox/inbox/template-variables";
import { LinkDialog } from "@/components/master-inbox/link-dialog";

// Rich text editor for reply templates. Outputs HTML (for body_html)
// and exposes the plain-text projection (for the legacy `body`
// column) via getText() on the editor instance.
//
// Toolbar: Insert variable, paragraph/H2, bold/italic/underline/
// strikethrough, bulleted + numbered list, link, plus the variables
// dropdown that wraps the picked token as {{key}} at the caret. We
// deliberately avoid font-family / size controls — the recipient's
// mail client strips those anyway and they were the riskiest part of
// the mockup (per-mail-client rendering differences).

export function TemplateRichEditor({
  valueHtml,
  onChange,
  placeholder = "Write the reply body…",
}: {
  valueHtml: string;
  onChange: (next: { html: string; text: string }) => void;
  placeholder?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Defaults are fine — paragraph, heading, bold, italic, strike,
        // lists, blockquote, hr, code, etc.
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: valueHtml || "",
    // suppressContentEditableWarning: avoid React's warning on TipTap's
    // contenteditable root (false here = silenced).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "tiptap min-h-[260px] max-h-[420px] overflow-y-auto px-3 py-2 text-sm focus:outline-none [&_p]:my-1 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-blue-600 [&_a]:underline",
      },
    },
    onUpdate: ({ editor }) => {
      // TipTap separates block nodes with \n\n. An empty paragraph
      // (which a user can produce by pressing Enter on a blank line)
      // emits an additional \n\n, so `<p>A</p><p></p><p>B</p>` becomes
      // `A\n\n\n\nB` — three visible blank lines in the composer
      // textarea. Collapse runs of 3+ newlines down to exactly 2 so a
      // single blank line between paragraphs is the most spacing
      // anyone ever sees.
      const rawText = editor.getText();
      const text = rawText.replace(/\n{3,}/g, "\n\n").trim();
      onChange({ html: editor.getHTML(), text });
    },
  });

  // Keep the editor's content in sync if the parent swaps templates
  // (e.g. user clicks a different template in the sidebar). Only push
  // when the incoming HTML actually differs from the editor's current
  // value, so the user's in-progress edits don't get clobbered.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (valueHtml !== current) {
      editor.commands.setContent(valueHtml || "", { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueHtml, editor]);

  if (!editor) {
    return (
      <div className="rounded-md border bg-background min-h-[260px] flex items-center justify-center text-xs text-muted-foreground">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-background flex flex-col">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInitialText, setLinkInitialText] = useState("");
  const [linkInitialUrl, setLinkInitialUrl] = useState("");
  const isEditingLink = isActive("link");

  function openLinkDialog() {
    const { state } = editor;
    const { from, to } = state.selection;
    const selectedText = state.doc.textBetween(from, to);
    const existingUrl =
      (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkInitialText(selectedText);
    setLinkInitialUrl(existingUrl);
    setLinkOpen(true);
  }

  function handleLinkSubmit({ text, url }: { text: string; url: string }) {
    const { state } = editor;
    const { from, to } = state.selection;
    const selectedText = state.doc.textBetween(from, to);
    if (isEditingLink || (selectedText && text === selectedText)) {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
    } else {
      const safeText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${safeUrl}">${safeText}</a>`)
        .run();
    }
  }

  function handleLinkRemove() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }

  function insertVariable(token: string) {
    editor.chain().focus().insertContent(`{{${token}}}`).run();
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-2 py-1.5">
      {/* Insert variable */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="h-7 px-2 inline-flex items-center gap-1 rounded text-[12px] font-medium text-foreground/80 hover:bg-accent transition-colors"
              title="Insert variable"
            >
              Insert variable <ChevronDown className="size-3" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-64 max-h-72 overflow-y-auto">
          {TEMPLATE_VARIABLES.map((v) => (
            <DropdownMenuItem
              key={v.key}
              onClick={() => insertVariable(v.key)}
              className="flex flex-col items-start gap-0"
            >
              <span className="text-[13px]">{v.label}</span>
              <code className="font-mono text-[11px] text-muted-foreground">{`{{${v.key}}}`}</code>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Sep />

      {/* Heading */}
      <ToolbarButton
        active={isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading"
      >
        <Heading2 className="size-3.5" />
      </ToolbarButton>

      <Sep />

      {/* Inline marks */}
      <ToolbarButton
        active={isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (⌘B)"
      >
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (⌘I)"
      >
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (⌘U)"
      >
        <UnderlineIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <Strikethrough className="size-3.5" />
      </ToolbarButton>

      <Sep />

      {/* Lists */}
      <ToolbarButton
        active={isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bulleted list"
      >
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        <ListOrdered className="size-3.5" />
      </ToolbarButton>

      <Sep />

      {/* Link */}
      <ToolbarButton
        active={isActive("link")}
        onClick={openLinkDialog}
        title="Add / edit link"
      >
        <LinkIcon className="size-3.5" />
      </ToolbarButton>
      <LinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        initialText={linkInitialText}
        initialUrl={linkInitialUrl}
        onSubmit={handleLinkSubmit}
        onRemove={isEditingLink ? handleLinkRemove : undefined}
      />
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded text-foreground/70 hover:bg-accent transition-colors",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />;
}
