import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, PanelLeftClose, Pencil, Plus, Search, Settings, Trash2 } from "lucide-react";

import type { Conversation, SearchHit } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SidebarProps {
  conversations: Conversation[];
  selectedId: number | null;
  open: boolean;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Jumps into a search hit's conversation, scrolled to the message. */
  onJumpTo: (hit: SearchHit) => void;
}

/**
 * Stays mounted so the width transition can animate both directions,
 * exactly like the Details panel; the fixed-width inner keeps content
 * from squishing while sliding.
 */
export function Sidebar({
  conversations,
  selectedId,
  open,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose,
  onOpenSettings,
  onJumpTo,
}: SidebarProps) {
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const searchMode = hits !== null;

  // Debounced full-text search: null hits means "not searching", an array
  // (possibly empty) means "show the results list".
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invoke<SearchHit[]>("search_messages", { query: trimmed, limit: 50 })
        .then((found) => {
          if (!cancelled) setHits(found);
        })
        .catch((err) => {
          console.error("Search failed:", err);
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const submitRename = (event: React.FormEvent) => {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!renaming || title.length === 0) return;
    onRename(renaming.id, title);
    setRenaming(null);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    onDelete(deleting.id);
    setDeleting(null);
  };

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
          "flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar",
          !open && "pointer-events-none"
        )}
      >
        <header className="flex items-center gap-1 px-4 py-2.5">
          <h1 className="font-display text-lg">Shaim</h1>
          <div className="ml-auto flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={onClose}
              aria-label="Hide sidebar"
              title="Hide sidebar"
            >
              <PanelLeftClose />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={onCreate}
              aria-label="New conversation"
              title="New conversation"
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={onOpenSettings}
              aria-label="Settings"
              title="Settings"
            >
              <Settings />
            </Button>
          </div>
        </header>

        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              aria-label="Search conversations"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {searchMode ? (
            hits.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                <p>No messages match “{query.trim()}”.</p>
              </div>
            ) : (
              hits.map((hit) => (
                <button
                  key={hit.message_id}
                  type="button"
                  onClick={() => onJumpTo(hit)}
                  className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
                >
                  <div className="flex items-center gap-1.5 truncate text-xs font-medium text-sidebar-foreground">
                    <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{hit.conversation_title}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {hit.snippet}
                  </p>
                </button>
              ))
            )
          ) : conversations.length === 0 ? (
            <div className="px-3 py-10 text-center text-xs text-muted-foreground">
              <p>No conversations yet.</p>
            </div>
          ) : (
            conversations.map((conversation) => (
              <ContextMenu key={conversation.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    className={cn(
                      "block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors",
                      conversation.id === selectedId
                        ? "bg-sidebar-accent text-sidebar-accent-foreground ring-2 ring-inset ring-emerald-700"
                        : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                  >
                    {conversation.title}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => {
                      setRenaming(conversation);
                      setRenameDraft(conversation.title);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onSelect={() => setDeleting(conversation)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          )}
        </nav>

        {/* Rename dialog */}
        <Dialog
          open={renaming !== null}
          onOpenChange={(open) => {
            if (!open) setRenaming(null);
          }}
        >
          <DialogContent>
            <form onSubmit={submitRename}>
              <DialogHeader>
                <DialogTitle>Rename conversation</DialogTitle>
                <DialogDescription>
                  Give this conversation a name you will recognize.
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                maxLength={120}
                className="mt-4"
              />
              <DialogFooter className="mt-4">
                <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={renameDraft.trim().length === 0}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation dialog */}
        <Dialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete conversation?</DialogTitle>
              <DialogDescription>
                “{deleting?.title}” and all of its messages will be permanently
                removed. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmDelete}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  );
}
