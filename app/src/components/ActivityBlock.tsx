import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

interface ActivityBlockProps {
  title: string;
  detail: string;
  /** Live blocks start open, persisted ones collapsed. */
  defaultOpen?: boolean;
}

/**
 * One collapsible tool/activity block: a tool call, a command run, thinking…
 * Collapsed by default — the title line is the summary, the detail opens on
 * click. The live streaming view and the persisted thread share this look.
 */
export function ActivityBlock({ title, detail, defaultOpen = false }: ActivityBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="animate-fade-in rounded-lg border border-border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate font-medium">{title}</span>
      </button>
      {open && detail.length > 0 && (
        <pre className="animate-fade-in max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {detail}
        </pre>
      )}
    </div>
  );
}
