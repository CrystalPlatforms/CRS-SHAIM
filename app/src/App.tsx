import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Conversation, SearchHit } from "@/types";
import { Sidebar } from "@/components/Sidebar";
import { ChatPane } from "@/components/ChatPane";
import { DetailPane } from "@/components/DetailPane";
import { SettingsDialog } from "@/components/SettingsDialog";

/** A pending "open this conversation scrolled to this message" request. */
interface JumpTarget {
  conversationId: number;
  messageId: number;
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Conversations still generating in the background (issue #21) — the
   * sidebar badges them so the work stays visible from any chat. */
  const [streamingIds, setStreamingIds] = useState<Set<number>>(new Set());
  /** Conversations whose last generation failed (issue #23) — the sidebar
   * marks them with the error loader until the next send clears it. */
  const [errorIds, setErrorIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setConversations(await invoke<Conversation[]>("list_conversations"));
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    try {
      const created = await invoke<Conversation>("create_conversation");
      await refresh();
      setSelectedId(created.id);
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const handleRename = async (id: number, title: string) => {
    try {
      await invoke("rename_conversation", { id, title });
      await refresh();
    } catch (error) {
      console.error("Failed to rename conversation:", error);
    }
  };

  /** ChatPane reports generations starting and finishing; a deleted
   * conversation drops its badge with it. */
  const handleStreamingChanged = useCallback((id: number, streaming: boolean) => {
    setStreamingIds((current) => {
      if (streaming ? current.has(id) : !current.has(id)) return current;
      const next = new Set(current);
      if (streaming) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  /** ChatPane reports failures — the sidebar shows the error mark; the
   * next send in that conversation clears it. */
  const handleErrorChanged = useCallback((id: number, hasError: boolean) => {
    setErrorIds((current) => {
      if (hasError ? current.has(id) : !current.has(id)) return current;
      const next = new Set(current);
      if (hasError) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_conversation", { id });
      await refresh();
      setSelectedId((current) => (current === id ? null : current));
      setStreamingIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setErrorIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (error) {
      console.error("Failed to delete conversation:", error);
    }
  };

  /** Opens a conversation by clicking its row — a pending jump for a
   * different conversation is stale and cleared. */
  const handleSelect = (id: number) => {
    setJumpTarget((current) =>
      current && current.conversationId !== id ? null : current,
    );
    setSelectedId(id);
  };

  /** Opens the hit's conversation and asks ChatPane to scroll to it. */
  const handleJumpTo = (hit: SearchHit) => {
    setJumpTarget({ conversationId: hit.conversation_id, messageId: hit.message_id });
    setSelectedId(hit.conversation_id);
  };

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        selectedId={selectedId}
        streamingIds={streamingIds}
        errorIds={errorIds}
        open={sidebarOpen}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        onJumpTo={handleJumpTo}
      />
      <ChatPane
        conversation={selected}
        sidebarOpen={sidebarOpen}
        onOpenSidebar={() => setSidebarOpen(true)}
        detailsOpen={detailsOpen}
        onOpenDetails={() => setDetailsOpen(true)}
        onConversationsChanged={() => void refresh()}
        onDelete={handleDelete}
        onSelectConversation={setSelectedId}
        jumpTarget={jumpTarget}
        onJumpHandled={() => setJumpTarget(null)}
        onStreamingChanged={handleStreamingChanged}
        onErrorChanged={handleErrorChanged}
      />
      <DetailPane
        conversation={selected}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        onConversationsChanged={() => void refresh()}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onServersChanged={() => void refresh()}
      />
    </div>
  );
}
