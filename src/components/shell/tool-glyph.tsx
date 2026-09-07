/*
 * The rail icons, traced from the design file.
 *
 * Inline SVG rather than a library import: these are six fixed glyphs, and the
 * design's `.ico` rule already sets stroke, width, linecap and opacity — a
 * library component that ships its own would fight it.
 */

const PATHS: Record<string, React.ReactNode> = {
  home: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </>
  ),
  performance: (
    <>
      <path d="M3 3v18h18" />
      <path d="M18 17V9M13 17V5M8 17v-3" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  clients: (
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  ),
  analytics: (
    <>
      <path d="M3 3v18h18" />
      <rect x="7" y="10" width="3" height="8" rx="1" />
      <rect x="12" y="6" width="3" height="12" rx="1" />
      <rect x="17" y="13" width="3" height="5" rx="1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </>
  ),
  onboarding: (
    <>
      <path d="M9 11l2.5 2.5L16 9" />
      <path d="M20 6.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9.5" />
      <path d="M8 3.5h6" />
    </>
  ),
  "team-access": (
    <>
      <path d="M16 21v-1.8a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4V21" />
      <circle cx="9.2" cy="7.5" r="3.8" />
      <path d="M22 11h-5.5" />
    </>
  ),
};

export function ToolGlyph({ id }: { id: string }) {
  const paths = PATHS[id];
  if (!paths) return null;
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {paths}
    </svg>
  );
}
