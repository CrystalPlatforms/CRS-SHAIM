import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import {
  ImagePlus,
  PanelLeftOpen,
  PanelRightOpen,
  SendHorizontal,
  Square,
} from "lucide-react";

import type { ChatStreamEvent, Conversation, Message } from "@/types";
import { Button } from "@/components/ui/button";
import { MessageView, PendingImages } from "@/components/MessageView";
import { AgentLoader } from "@/components/AgentLoader";

interface ChatPaneProps {
  conversation: Conversation | null;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  detailsOpen: boolean;
  onOpenDetails: () => void;
  /** Notifies the parent when auto-title (or anything else) changed the list. */
  onConversationsChanged: () => void;
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

interface StreamState {
  content: string;
  thinking: string;
}

/**
 * Deltas arrive faster than React should re-render; they accumulate in a ref
 * and flush into state on a timer, so typing never competes with the stream.
 */
const FLUSH_INTERVAL_MS = 60;

export function ChatPane({
  conversation,
  sidebarOpen,
  onOpenSidebar,
  detailsOpen,
  onOpenDetails,
  onConversationsChanged,
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generationRef = useRef<number | null>(null);
  const bufferRef = useRef<StreamState>({ content: "", thinking: "" });
  const streamingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // While the user is parked near the bottom, new content keeps the view
  // pinned there; scrolling up to read pauses the chase until they return.
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Follow the growing thread: new messages and stream flushes keep the
  // latest content in view (unless the user scrolled away).
  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, stream, scrollToBottom]);

  // Load the thread whenever the selected conversation changes.
  useEffect(() => {
    streamingRef.current = false;
    stickToBottomRef.current = true;
    setMessages([]);
    setStream(null);
    setError(null);
    setPendingImages([]);
    setDraft("");
    if (!conversation) return;

    let cancelled = false;
    invoke<Message[]>("list_messages", { conversationId: conversation.id })
      .then((loaded) => {
        if (!cancelled) setMessages(loaded);
      })
      .catch((err) => console.error("Failed to load messages:", err));
    return () => {
      cancelled = true;
    };
  }, [conversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushBuffer = useCallback(() => {
    if (!streamingRef.current) return;
    setStream({ ...bufferRef.current });
  }, []);

  const reloadMessages = useCallback(async (conversationId: number) => {
    try {
      setMessages(await invoke<Message[]>("list_messages", { conversationId }));
    } catch (err) {
      console.error("Failed to reload messages:", err);
    }
  }, []);

  const stop = useCallback(async () => {
    if (generationRef.current === null) return;
    try {
      await invoke("stop_generation", { generationId: generationRef.current });
    } catch (err) {
      console.error("Failed to stop generation:", err);
    }
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!conversation || streamingRef.current) return;
    if (text.length === 0 && pendingImages.length === 0) return;

    const sentText = text;
    const sentImages = pendingImages;
    setDraft("");
    setPendingImages([]);
    setError(null);

    bufferRef.current = { content: "", thinking: "" };
    streamingRef.current = true;
    setStream({ content: "", thinking: "" });
    // Sending always means "show me the latest" — even if the user had
    // scrolled up, ride down to the new message.
    stickToBottomRef.current = true;
    scrollToBottom(true);

    const channel = new Channel<ChatStreamEvent>();
    channel.onmessage = (event) => {
      switch (event.type) {
        case "user_message":
          setMessages((current) => [
            ...current,
            {
              id: event.id,
              conversation_id: conversation.id,
              role: "user",
              content: event.content,
              thinking: null,
              images: event.images,
              reaction: null,
              created_at: Math.floor(Date.now() / 1000),
            },
          ]);
          break;
        case "thinking":
          bufferRef.current.thinking += event.text;
          break;
        case "content":
          bufferRef.current.content += event.text;
          break;
        case "title_changed":
          onConversationsChanged();
          break;
        case "done": {
          streamingRef.current = false;
          generationRef.current = null;
          setMessages((current) => [
            ...current,
            {
              id: event.message_id,
              conversation_id: conversation.id,
              role: "assistant",
              content: event.content,
              thinking: event.thinking.length > 0 ? event.thinking : null,
              images: [],
              reaction: null,
              created_at: Math.floor(Date.now() / 1000),
            },
          ]);
          setStream(null);
          if (event.aborted) onConversationsChanged();
          break;
        }
        case "error":
          streamingRef.current = false;
          generationRef.current = null;
          setError(event.message);
          setStream(null);
          // A failed/partial stream persists what arrived — reload to show it.
          void reloadMessages(conversation.id);
          break;
      }
    };

    try {
      generationRef.current = await invoke<number>("send_message", {
        conversationId: conversation.id,
        content: sentText,
        images: sentImages,
        channel,
      });
    } catch (err) {
      streamingRef.current = false;
      generationRef.current = null;
      setStream(null);
      setError(String(err));
      onConversationsChanged();
    }
  }, [
    conversation,
    draft,
    pendingImages,
    onConversationsChanged,
    reloadMessages,
  ]);

  // Grow the composer with its content, up to the max height.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [draft]);

  // Flush loop while streaming — keeps renders batched, typing responsive.
  useEffect(() => {
    if (stream === null) return;
    const timer = window.setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [stream !== null, flushBuffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const attachImages = async (files: FileList | null) => {
    if (!files) return;
    const readers = Array.from(files).map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    );
    try {
      const dataUrls = await Promise.all(readers);
      setPendingImages((current) => [...current, ...dataUrls]);
    } catch (err) {
      console.error("Failed to read image files:", err);
    }
  };

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
        <h2 className="font-display text-9xl leading-none animate-fade-in">
          Shaim
        </h2>
      </section>
    );
  }

  const isStreaming = stream !== null;

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

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 space-y-3 overflow-y-auto px-6 py-4"
      >
        {messages.length === 0 && !isStreaming ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground">
              This is the beginning of “{conversation.title}”.
            </p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
            {isStreaming && <StreamingMessage stream={stream} />}
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-border p-4">
        {isStreaming && (
          <div className="mb-2 flex items-center gap-2 px-1 text-muted-foreground">
            <AgentLoader type="orbit" dotClassName="h-[3px] w-[3px]" />
            <span className="text-xs italic">Discombobulating...</span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <label
            className="flex h-[38px] w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground"
            title="Attach images"
          >
            <ImagePlus className="h-5 w-5" />
            <span className="sr-only">Attach images</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void attachImages(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <div className="min-w-0 flex-1 rounded-lg border border-border bg-card">
            <PendingImages
              images={pendingImages}
              onRemove={(index) =>
                setPendingImages((current) =>
                  current.filter((_, i) => i !== index),
                )
              }
            />
            <div className="flex items-end gap-1 px-2 py-1">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Write a message…"
                className="max-h-40 min-h-7 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
              />
              {isStreaming ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void stop()}
                  aria-label="Stop generating"
                  title="Stop generating"
                  className="text-destructive"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void send()}
                  disabled={
                    draft.trim().length === 0 && pendingImages.length === 0
                  }
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  );
}

/** The in-flight assistant message: plain streaming text, no chrome — the
 * orbit loader lives pinned above the composer. */
function StreamingMessage({ stream }: { stream: StreamState }) {
  return (
    <div className="flex w-full justify-start px-1">
      <div className="max-w-[85%] min-w-0">
        {stream.thinking.length > 0 && (
          <p className="mb-1 whitespace-pre-wrap text-xs italic text-muted-foreground">
            {stream.thinking}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm">{stream.content}</p>
      </div>
    </div>
  );
}
