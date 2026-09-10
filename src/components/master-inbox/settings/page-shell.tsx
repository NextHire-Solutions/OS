interface Props {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function SettingsPageShell({ title, description, actions, children }: Props) {
  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function ComingSoon({ name }: { name: string }) {
  return (
    <div className="rounded-lg border bg-card p-8 text-center">
      <p className="text-sm font-medium">{name}</p>
      <p className="text-xs text-muted-foreground mt-1">This section will land in a later phase.</p>
    </div>
  );
}
