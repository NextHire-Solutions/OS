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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { TEMPLATE_VARIABLES } from "@/lib/tools/master-inbox/inbox/template-variables";
import { LinkDialog } from "@/components/master-inbox/link-dialog";

/*
 * Rich text editor for reply templates. Outputs HTML (for body_html) and
 * exposes the plain-text projection (for the legacy `body` column) via
 * getText() on the editor instance.
 *
 * Toolbar: Insert variable, H2, bold/italic/underline/strikethrough, bulleted
 * and numbered list, link, plus the variables dropdown that wraps the picked
 * token as {{key}} at the caret. Font family and size are deliberately absent —
 * the recipient's mail client strips those anyway.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED IN THE REBUILD
 *
 * Nothing about the editor. Every extension, every command and every toolbar
 * item is the same; the plain-text collapse of TipTap's triple newlines is the
 * same.
 *
 * What changed is that the chrome is no longer Tailwind. The editing surface
 * used to carry a 33-class `editorProps.attributes.class` string — including
 * the block styles for headings, lists and links — which meant a template body
 * rendered in the tool's typography inside a workspace that uses the design's.
 * Those block styles now live in `mi-settings.css` under `.mis-ed .tiptap`, at
 * the same 14px / 1.65 the design gives a message body, so what you type looks
 * like what the conversation view will show.
 */

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
    /*
     * The toolbar's pressed states DID NOT WORK before this line, and it took
     * driving them in a browser to notice.
     *
     * `@tiptap/react` v3 defaults `shouldRerenderOnTransaction` to false — it
     * is a real performance decision for a big document — but every one of the
     * eight toolbar buttons below asks `editor.isActive(...)` during render.
     * With no re-render on a transaction, that answer was computed once when
     * the editor mounted and never again: Bold never lit up, and neither did
     * the heading, the lists or the link. The tool's markup had the same
     * problem, so nobody had ever seen this toolbar show its own state.
     *
     * A reply template is a few hundred words, so the re-render is cheap and
     * it is the whole point of having a toolbar.
     */
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        // Just the hook. The look is `.mis-ed .tiptap` in mi-settings.css.
        class: "tiptap",
        "aria-label": "Template body",
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
      <div className="mis-ed">
        <div className="mis-ed-load">Loading editor…</div>
      </div>
    );
  }

  return (
    <div className="mis-ed">
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
    const existingUrl = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkInitialText(selectedText);
    setLinkInitialUrl(existingUrl);
    setLinkOpen(true);
  }

  function handleLinkSubmit({ text, url }: { text: string; url: string }) {
    const { state } = editor;
    const { from, to } = state.selection;
    const selectedText = state.doc.textBetween(from, to);
    if (isEditingLink || (selectedText && text === selectedText)) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      const safeText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      editor.chain().focus().insertContent(`<a href="${safeUrl}">${safeText}</a>`).run();
    }
  }

  function handleLinkRemove() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }

  function insertVariable(token: string) {
    editor.chain().focus().insertContent(`{{${token}}}`).run();
  }

  return (
    <div className="mis-ed-t" role="toolbar" aria-label="Formatting">
      {/* Insert variable */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" className="mis-ed-v" title="Insert variable">
              Insert variable <ChevronDown aria-hidden />
            </button>
          }
        />
        <DropdownMenuContent
          align="start"
          style={{ width: 268, maxHeight: 300, overflowY: "auto" }}
        >
          {TEMPLATE_VARIABLES.map((v) => (
            <DropdownMenuItem
              key={v.key}
              onClick={() => insertVariable(v.key)}
              className="mis-var"
            >
              <span>{v.label}</span>
              <code>{`{{${v.key}}}`}</code>
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
        <Heading2 aria-hidden />
      </ToolbarButton>

      <Sep />

      {/* Inline marks */}
      <ToolbarButton
        active={isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (⌘B)"
      >
        <Bold aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (⌘I)"
      >
        <Italic aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (⌘U)"
      >
        <UnderlineIcon aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <Strikethrough aria-hidden />
      </ToolbarButton>

      <Sep />

      {/* Lists */}
      <ToolbarButton
        active={isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bulleted list"
      >
        <List aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        active={isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        <ListOrdered aria-hidden />
      </ToolbarButton>

      <Sep />

      {/* Link */}
      <ToolbarButton active={isActive("link")} onClick={openLinkDialog} title="Add / edit link">
        <LinkIcon aria-hidden />
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
      /*
       * `aria-pressed` rather than a class: it is the state the control
       * actually has, the stylesheet keys the raised "on" look off it, and a
       * screen reader — or a test — can read whether Bold is currently on.
       */
      aria-pressed={Boolean(active)}
      aria-label={title}
      className="mis-ed-b"
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mis-ed-sep" aria-hidden="true" />;
}
