import { cn } from "@/lib/tools/master-inbox/utils";

const COLOR_CLASSES: Record<string, string> = {
  green:  "bg-emerald-100 text-emerald-700 border-emerald-200",
  red:    "bg-red-100 text-red-700 border-red-200",
  amber:  "bg-amber-100 text-amber-800 border-amber-200",
  zinc:   "bg-zinc-100 text-zinc-700 border-zinc-200",
  stone:  "bg-stone-100 text-stone-700 border-stone-200",
  pink:   "bg-pink-100 text-pink-700 border-pink-200",
  blue:   "bg-blue-100 text-blue-700 border-blue-200",
};

export function LabelChip({
  name,
  color = "zinc",
  className,
}: {
  name: string;
  color?: string;
  className?: string;
}) {
  const classes = COLOR_CLASSES[color] ?? COLOR_CLASSES.zinc;
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border whitespace-nowrap",
        classes,
        className,
      )}
    >
      {name}
    </span>
  );
}
