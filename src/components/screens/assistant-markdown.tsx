"use client";

import { Fragment, type ReactNode } from "react";

/*
 * Just enough Markdown for an answer.
 *
 * The model replies in Markdown — bold for client names, numbered lists for a
 * few results, a table once there are more than three. Rendering that as plain
 * text put literal `**Douglas Elliman NYC**` on screen, which reads as the
 * assistant being broken rather than as emphasis.
 *
 * Hand-written rather than a dependency because the input is not arbitrary
 * Markdown from the internet: it is one model, instructed in the system
 * prompt, producing headings, bold, lists, tables and inline code. A parser
 * for the whole spec would be several hundred kilobytes to cover cases that
 * cannot occur here.
 *
 * NOTHING IS RENDERED AS HTML. Every branch below builds React elements from
 * text, so a model that emits `<script>` produces the visible characters
 * `<script>` — which is the only safe way to render text that came back from
 * an API and has passed through a database.
 */

/** `**bold**`, `*italic*` and `` `code` ``, applied to one line of text. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith("**")) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={key} className="asst-code">{token.slice(1, -1)}</code>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
/** `|---|:--:|` — the row that turns the line above it into a header. */
const isTableRule = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");

const cellsOf = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function AssistantMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `p${blocks.length}`;
    blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = `l${blocks.length}`;
    const items = list.items.map((item, n) => <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>);
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      continue;
    }

    // A table: the header row, its rule, then every row until one is not.
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flush();
      const header = cellsOf(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        rows.push(cellsOf(lines[j]));
        j++;
      }
      const key = `t${blocks.length}`;
      blocks.push(
        /* Its own scroller: a ten-column ranking must not widen the page. */
        <div key={key} className="asst-table-wrap">
          <table className="asst-table">
            <thead>
              <tr>{header.map((h, n) => <th key={n}>{inline(h, `${key}-h${n}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => <td key={c}>{inline(cell, `${key}-${r}-${c}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const key = `h${blocks.length}`;
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key}>{inline(heading[2], key)}</Tag>);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      flushParagraph();
      const wantOrdered = Boolean(ordered);
      if (!list || list.ordered !== wantOrdered) {
        flushList();
        list = { ordered: wantOrdered, items: [] };
      }
      list.items.push((ordered ?? bullet)![1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return <Fragment>{blocks}</Fragment>;
}
