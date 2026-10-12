import { PanelLeftOpen, PanelRightOpen, SendHorizontal } from "lucide-react";

import type { Conversation } from "@/types";
import { Button } from "@/components/ui/button";

interface ChatPaneProps {
  conversation: Conversation | null;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  detailsOpen: boolean;
  onOpenDetails: () => void;
}

function ShowSidebarButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="animate-slide-in-left [animation-delay:200ms]">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground"
        onClick={onClick}
        aria-label="Show sidebar"
        title="Show sidebar"
      >
        <PanelLeftOpen />
      </Button>
    </div>
  );
}

function ShowDetailsButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="animate-slide-in-right [animation-delay:200ms]">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground"
        onClick={onClick}
        aria-label="Show details"
        title="Show details"
      >
        <PanelRightOpen />
      </Button>
    </div>
  );
}

export function ChatPane({
  conversation,
  sidebarOpen,
  onOpenSidebar,
  detailsOpen,
  onOpenDetails,
}: ChatPaneProps) {
  if (!conversation) {
    return (
      <section className="relative flex min-w-0 flex-1 items-center justify-center px-6">
        {!sidebarOpen && (
          <div className="absolute left-3 top-3">
            <ShowSidebarButton onClick={onOpenSidebar} />
          </div>
        )}
        {!detailsOpen && (
          <div className="absolute right-3 top-3">
            <ShowDetailsButton onClick={onOpenDetails} />
          </div>
        )}
        <h2 className="font-display text-9xl leading-none animate-fade-in">Shaim</h2>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-5 py-2.5">
        {!sidebarOpen && <ShowSidebarButton onClick={onOpenSidebar} />}
        <h2 className="truncate text-sm font-semibold">{conversation.title}</h2>
        {!detailsOpen && (
          <div className="ml-auto shrink-0">
            <ShowDetailsButton onClick={onOpenDetails} />
          </div>
        )}
      </header>

      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-xs text-muted-foreground">
          This is the beginning of “{conversation.title}”.
        </p>
      </div>

      {/* Placeholder composer — comes alive with the first model connection. */}
      <footer className="border-t border-border p-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <input
            disabled
            placeholder="Messaging arrives in the next phase"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button size="icon" variant="ghost" disabled aria-label="Send">
            <SendHorizontal />
          </Button>
        </div>
      </footer>
    </section>
  );
}
