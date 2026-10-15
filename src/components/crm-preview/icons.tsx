/*
 * The redesign's own icons, copied from the client's handoff (each is a 24×24
 * stroked outline; only geometry — path, rect, circle — was taken from it).
 */

import type { ReactNode } from "react";

const SHAPES = {
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  pipeline: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></>,
  reports: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  campaigns: <><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c1.8.7 3 2.4 3.5 5.2" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  plug: <><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 3.5M12 17h.01" /></>,
  stages: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
  chevDown: <><path d="M6 9l6 6 6-6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  board: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="16" rx="1.5" /><rect x="17" y="4" width="4" height="16" rx="1.5" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 20h16" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  chat: <><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z" /></>,
  pencil: <><path d="M4 20h4L19 9l-4-4L4 16v4z" /></>,
  note: <><path d="M5 4h10l4 4v12H5z" /><path d="M15 4v4h4M8 13h8M8 17h5" /></>,
  chevRight: <><path d="M9 6l6 6-6 6" /></>,
  x: <><path d="M18 6L6 18M6 6l12 12" /></>,
  check: <><path d="M5 12l5 5L20 7" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /></>,
  building: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  externalSmall: <><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {SHAPES[name]}
    </svg>
  );
}
