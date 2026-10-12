import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Conversation } from "@/types";
import { Sidebar } from "@/components/Sidebar";
import { ChatPane } from "@/components/ChatPane";
import { DetailPane } from "@/components/DetailPane";

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);

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

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_conversation", { id });
      await refresh();
      setSelectedId((current) => (current === id ? null : current));
    } catch (error) {
      console.error("Failed to delete conversation:", error);
    }
  };

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        selectedId={selectedId}
        open={sidebarOpen}
        onSelect={setSelectedId}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setSidebarOpen(false)}
      />
      <ChatPane
        conversation={selected}
        sidebarOpen={sidebarOpen}
        onOpenSidebar={() => setSidebarOpen(true)}
        detailsOpen={detailsOpen}
        onOpenDetails={() => setDetailsOpen(true)}
      />
      <DetailPane
        conversation={selected}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </div>
  );
}
