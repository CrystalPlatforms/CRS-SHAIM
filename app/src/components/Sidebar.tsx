import { useState } from "react";
import { PanelLeftClose, Pencil, Plus, Settings, Trash2 } from "lucide-react";

import type { Conversation } from "@/types";
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
}: SidebarProps) {
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);

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

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
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
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
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
