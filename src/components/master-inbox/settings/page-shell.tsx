/*
 * The frame every settings panel sits in.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED
 *
 * It used to be `max-w-4xl mx-auto px-8 py-8` with a Tailwind heading — the
 * tool's shell, which `mi-skin.css` then wrapped in a single card so that the
 * panel read as one white sheet floating on the page.
 *
 * The mockup does not draw a screen that way. Every screen in the workspace is
 * a page on the grey ground carrying several cards and tables, and the settings
 * panels were the only place that looked different. So the shell is now a plain
 * `.mis` page — the card-per-panel treatment is opted out of by name in
 * `mi-settings.css` — and each panel composes its own `.card` / `.tbl-wrap`
 * sections the way `onboarding/stages.tsx` and `agent-search/*` already do.
 *
 * The title block matches the design's `.tbl-head`: a 21px semibold line with
 * negative tracking, a 13.5px muted description under it, and room on the
 * right for the panel's primary action.
 */

interface Props {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function SettingsPageShell({ title, description, actions, children }: Props) {
  return (
    <div className="mis">
      <div className="mis-hd">
        <div className="mis-hd-t">
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="mis-hd-a">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/*
 * A placeholder in the tool as well — this is not a gap introduced by the port,
 * and the words are the ones the live app shows. Drawn as the design draws an
 * empty state rather than as a dashed Tailwind box, so a tab with nothing in it
 * still looks like the product.
 */
export function ComingSoon({ name }: { name: string }) {
  return (
    <div className="mis-sec card">
      <div className="mis-empty">
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <b>{name}</b>
        <p>This section will land in a later phase.</p>
      </div>
    </div>
  );
}
