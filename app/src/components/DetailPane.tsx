import { PanelRightClose } from "lucide-react";

import type { Conversation } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cnValue(muted)}>{value}</span>
    </div>
  );
}

function cnValue(muted: boolean) {
  return muted ? "text-muted-foreground/60" : "text-foreground";
}

interface DetailPaneProps {
  conversation: Conversation | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Stays mounted so the width transition can animate both directions;
 * the fixed-width inner keeps content from squishing while sliding.
 */
export function DetailPane({ conversation, open, onClose }: DetailPaneProps) {
  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
        open ? "w-64" : "w-0"
      )}
    >
      <div
        className={cn(
          "flex h-full w-64 flex-col border-l border-sidebar-border bg-sidebar",
          !open && "pointer-events-none"
        )}
      >
        <header className="flex items-center px-4 py-2.5">
          <h2 className="text-sm font-semibold">Details</h2>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto text-muted-foreground"
            onClick={onClose}
            aria-label="Hide details"
            title="Hide details"
          >
            <PanelRightClose />
          </Button>
        </header>

        <div className="space-y-3 p-4 text-xs">
          <Row
            label="Mode"
            value={
              conversation
                ? conversation.mode.charAt(0).toUpperCase() + conversation.mode.slice(1)
                : "—"
            }
          />
          <Row label="Server" value="Not configured" muted />
          <Row label="Model" value="Not selected" muted />
        </div>
      </div>
    </aside>
  );
}
