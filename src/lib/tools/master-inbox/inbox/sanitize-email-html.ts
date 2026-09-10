// Strip the parts of a provider-supplied HTML body that can leak
// styles out of the message container OR run arbitrary script.
//
// Email clients ship random `<style>` blocks (Gmail signatures,
// Outlook conditional comments, etc.) — pasting them straight into
// our document scopes them to the whole page and clobbers the
// portal / inbox chrome. Same with `<link rel="stylesheet">`. And
// `<script>` is straight XSS exposure.
//
// Used by:
//   • components/inbox/thread-view.tsx (staff thread renderer)
//   • components/portals/conversation-sheet.tsx (client portal
//     read-only conversation view)
//
// Both surfaces wrap the result in a TipTap / prose container that
// already neutralises layout-affecting tags, so this regex pass is
// the only sanitisation needed on top.
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*\/?>/gi, "");
}
