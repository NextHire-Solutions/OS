interface Props {
  title: string;
  description: string;
}

export function FolderEmpty({ title, description }: Props) {
  return (
    <>
      <div className="h-12 shrink-0 border-b bg-background flex items-center px-4">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
      </div>
    </>
  );
}
