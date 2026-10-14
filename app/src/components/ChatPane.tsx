import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import {
  ImagePlus,
  PanelLeftOpen,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  Reply,
  SendHorizontal,
  Square,
  X,
} from "lucide-react";

import type { ChatStreamEvent, Conversation, Message } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  /** Selects another conversation — used after a fork. */
  onSelectConversation: (id: number) => void;
  /** Pending "scroll to this message" request from a search hit. */
  jumpTarget: { conversationId: number; messageId: number } | null;
  /** Acknowledges the jump once it has been performed. */
  onJumpHandled: () => void;
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

/** A message being edited: sending continues the conversation from it. */
interface EditState {
  id: number;
  content: string;
}

/** A message being replied to: the composer shows a snippet, the sent
 * message carries the full markdown quote so the model keeps context. */
interface ReplyState {
  id: number;
  snippet: string;
  quote: string;
}

/** A selection inside an assistant message the user asked about: each pill
 * shows a few words, the sent message carries every selection. More than
 * one can pile up in the composer. */
interface AskState {
  /** Local key — several asks can coexist. */
  key: number;
  snippet: string;
  quote: string;
}

/** Floating "Ask about it" button pinned to the end of a selection. */
interface AskButton {
  top: number;
  left: number;
  text: string;
}

/** Snippet for the reply chip: the first non-empty line, char-safe cut. */
function snippetOf(content: string): string {
  const MAX = 64;
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const more = firstLine.length > MAX || content.includes("\n");
  const visible = Array.from(firstLine).slice(0, MAX).join("");
  return visible.length < firstLine.length || more ? `${visible}…` : visible;
}

/** Snippet for the ask pill: the first few words, then "…". */
function wordsSnippet(content: string, maxWords = 5): string {
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/** Markdown blockquote of an arbitrary text (full message or selection). */
function quoteOf(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Lucide `quote` icon, inlined for imperatively-built ask chips. */
const QUOTE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`;

/** Builds the inline ask chip: snippet + quote icon. Click asks for removal
 * (confirmation dialog); dragging is pointer-driven (ChatPane's manual
 * drag — HTML5 drag&drop is unreliable inside a contentEditable). Lives
 * inside the composer as a non-editable inline element. */
function buildAskChip(key: number, snippet: string): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute("data-ask-chip", String(key));
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute("title", "Drag to move · click to remove");
  chip.className =
    "mx-0.5 inline-flex max-w-[260px] cursor-grab select-none items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 align-middle text-xs active:cursor-grabbing";
  const label = document.createElement("span");
  label.className = "min-w-0 truncate italic text-muted-foreground";
  label.textContent = snippet;
  const icon = document.createElement("span");
  icon.className = "shrink-0 text-muted-foreground [&_svg]:block";
  icon.innerHTML = QUOTE_ICON_SVG;
  chip.append(label, icon);
  return chip;
}

/** Typed text of the composer: chip contents are excluded (they are
 * context, not message text), BR/DIV boundaries become newlines. */
function composerText(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.hasAttribute("data-ask-chip")) return;
    if (element.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = element.tagName === "DIV" || element.tagName === "P";
    if (block && out.length > 0 && !out.endsWith("\n")) out += "\n";
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block && !out.endsWith("\n")) out += "\n";
  };
  for (const child of Array.from(el.childNodes)) walk(child);
  // Zero-width spaces exist to hold a visible caret right after a chip.
  return out.replace(/​/g, "").replace(/\n+$/, "");
}

/** The outgoing message: the composer in order — typed text with each ask
 * quote embedded exactly where its chip sits (blank lines keep the
 * markdown blockquote intact inside the sentence). */
function composerMessage(
  el: HTMLElement,
  quoteFor: (key: number) => string | undefined,
): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.hasAttribute("data-ask-chip")) {
      const quote = quoteFor(Number(element.getAttribute("data-ask-chip")));
      if (quote) {
        if (out.length > 0 && !out.endsWith("\n")) out += "\n\n";
        else if (out.length > 0) out += "\n";
        out += quote;
        out += "\n\n";
      }
      return;
    }
    if (element.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = element.tagName === "DIV" || element.tagName === "P";
    if (block && out.length > 0 && !out.endsWith("\n")) out += "\n";
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block && !out.endsWith("\n")) out += "\n";
  };
  for (const child of Array.from(el.childNodes)) walk(child);
  return out
    .replace(/​/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Caret position for drop coordinates — WebKit and Firefox spellings. */
function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/** Puts a VISIBLE caret right after the chip. WebKit hides a caret parked
 * on an element boundary, so it lands inside a text node instead — a
 * zero-width space is planted when there is no text to lean on
 * (composerText strips it again). */
function placeCaretAfterChip(chip: Element) {
  const sel = window.getSelection();
  if (!sel) return;
  let node: Node | null = chip.nextSibling;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    node = document.createTextNode("​");
    chip.parentElement?.insertBefore(node, chip.nextSibling);
  }
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
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
  onSelectConversation,
  jumpTarget,
  onJumpHandled,
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [replying, setReplying] = useState<ReplyState | null>(null);
  const [asks, setAsks] = useState<AskState[]>([]);
  const [askButton, setAskButton] = useState<AskButton | null>(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  /** A chip the user clicked — waiting for removal confirmation. */
  const [removingAsk, setRemovingAsk] = useState<{ key: number; snippet: string } | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const generationRef = useRef<number | null>(null);
  const bufferRef = useRef<StreamState>({ content: "", thinking: "" });
  const streamingRef = useRef(false);
  /** The composer is a contentEditable — plain text + inline ask chips. */
  const composerRef = useRef<HTMLDivElement>(null);
  /** Typed text stashed while the user edits an older message. */
  const draftStashRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // While the user is parked near the bottom, new content keeps the view
  // pinned there; scrolling up to read pauses the chase until they return.
  const stickToBottomRef = useRef(true);
  // Escape during a title edit must cancel, not save-on-blur.
  const titleCancelledRef = useRef(false);
  // Keys for the accumulated "Ask about it" selections.
  const askKeyRef = useRef(1);
  // A drag that moved a chip must not open the removal dialog on release.
  const suppressChipClickRef = useRef(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // A fixed "Ask about it" button would drift away from its selection.
    setAskButton(null);
  }, []);

  // Selection released: offer "Ask about it" — but only when it lives
  // inside an assistant message.
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setAskButton(null);
      return;
    }
    const text = sel.toString().trim();
    const anchor = sel.anchorNode;
    const anchorEl =
      anchor?.nodeType === Node.TEXT_NODE
        ? anchor.parentElement
        : (anchor as Element | null);
    const messageEl = anchorEl?.closest("[data-message-id]");
    if (text.length === 0 || !messageEl) {
      setAskButton(null);
      return;
    }
    const messageId = Number(messageEl.getAttribute("data-message-id"));
    const message = messages.find((m) => m.id === messageId);
    if (!message || message.role !== "assistant") {
      setAskButton(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setAskButton({ top: rect.bottom + 6, left: rect.left, text });
  }, [messages]);

  // Collapse the offer as soon as the selection goes away (click elsewhere,
  // Esc, new selection started).
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setAskButton(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  /** "Ask about it": append the selection as an inline chip at the END of
   * the composer (drag it anywhere afterwards). The chip shows a few words;
   * the sent message carries the whole selection so the model can answer
   * about the concrete fragment. More selections pile up as more chips. */
  const askAbout = useCallback((text: string) => {
    setAskButton(null);
    const key = askKeyRef.current++;
    const ask: AskState = {
      key,
      snippet: wordsSnippet(text),
      quote: quoteOf(text),
    };
    setAsks((current) => [...current, ask]);

    const el = composerRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // end of the typed text
    const chip = buildAskChip(key, ask.snippet);
    range.insertNode(chip);
    placeCaretAfterChip(chip);
    setDraft(composerText(el));
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
    if (composerRef.current) composerRef.current.textContent = "";
    setEditing(null);
    setReplying(null);
    setAsks([]);
    setAskButton(null);
    setDeleting(null);
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

  /**
   * Runs one chat command (send_message / regenerate / edit_message) and
   * drives its stream. All three converge on "history as stored → one
   * streamed assistant message appended", so they share this single path.
   */
  const runCommand = useCallback(
    (conversationId: number, command: string, args: Record<string, unknown>) => {
      if (streamingRef.current) return;
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
                conversation_id: conversationId,
                role: "user",
                content: event.content,
                thinking: null,
                images: event.images,
                reaction: null,
                created_at: Math.floor(Date.now() / 1000),
              },
            ]);
            break;
          case "history":
            // The store rewrote the path (edit truncation, regenerate
            // removal) — mirror the canonical history wholesale.
            setMessages(event.messages);
            break;
          case "started":
            // The id arrives before the stream does — Stop works mid-flight
            // (the command itself only returns once everything finished).
            generationRef.current = event.generation_id;
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
                conversation_id: conversationId,
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
            void reloadMessages(conversationId);
            break;
        }
      };

      invoke<number>(command, { conversationId, ...args, channel })
        .then((id) => {
          generationRef.current = id;
        })
        .catch((err) => {
          streamingRef.current = false;
          generationRef.current = null;
          setStream(null);
          setError(String(err));
          onConversationsChanged();
        });
    },
    [onConversationsChanged, reloadMessages, scrollToBottom],
  );

  /** Drops every ask chip — DOM first, then the mirrored state. */
  const clearAsks = useCallback(() => {
    composerRef.current
      ?.querySelectorAll("[data-ask-chip]")
      .forEach((chip) => chip.remove());
    setAsks([]);
  }, []);

  /**
   * Pointer-driven chip dragging — HTML5 drag&drop never fires a usable
   * drop inside a contentEditable in WebKit. The chip follows the pointer
   * as a ghost, a green marker shows exactly where the chip would land;
   * on release it moves to the caret position under the cursor. A release
   * without movement stays a plain click (which opens the removal dialog
   * via the click handler).
   */
  const beginAskDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, chip: HTMLElement) => {
      if (event.button !== 0) return;
      const rect = chip.getBoundingClientRect();
      const ghost = chip.cloneNode(true) as HTMLElement;
      ghost.style.position = "fixed";
      ghost.style.left = "0px";
      ghost.style.top = "0px";
      ghost.style.zIndex = "100";
      ghost.style.pointerEvents = "none";
      ghost.style.opacity = "0.9";
      ghost.style.width = `${rect.width}px`;
      document.body.appendChild(ghost);
      chip.style.opacity = "0.35";

      // Vertical green line at the drop position.
      const marker = document.createElement("div");
      marker.style.position = "fixed";
      marker.style.left = "0px";
      marker.style.top = "0px";
      marker.style.width = "2px";
      marker.style.borderRadius = "1px";
      marker.style.background = "rgb(16 185 129)";
      marker.style.boxShadow = "0 0 6px rgb(16 185 129 / 0.7)";
      marker.style.pointerEvents = "none";
      marker.style.zIndex = "100";
      marker.style.display = "none";
      document.body.appendChild(marker);

      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      let moved = false;

      const onMove = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 5) {
          return;
        }
        moved = true;
        ghost.style.transform = `translate(${e.clientX - offsetX}px, ${e.clientY - offsetY}px)`;
        const el = composerRef.current;
        const target = el ? caretRangeFromPoint(e.clientX, e.clientY) : null;
        const lineRect =
          target && el && el.contains(target.startContainer)
            ? (target.getClientRects()[0] ?? null)
            : null;
        if (lineRect) {
          marker.style.display = "block";
          marker.style.height = `${lineRect.height}px`;
          marker.style.transform = `translate(${lineRect.left}px, ${lineRect.top}px)`;
        } else {
          marker.style.display = "none";
        }
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onFinish);
        window.removeEventListener("pointercancel", onCancel);
        ghost.remove();
        marker.remove();
        chip.style.opacity = "";
      };
      const onCancel = () => cleanup();
      const onFinish = (e: PointerEvent) => {
        cleanup();
        if (!moved) return; // plain click — the click handler takes over
        suppressChipClickRef.current = true;
        const el = composerRef.current;
        if (!el) return;
        const target = caretRangeFromPoint(e.clientX, e.clientY);
        if (
          !target ||
          !el.contains(target.startContainer) ||
          chip.contains(target.startContainer)
        ) {
          return; // released outside the text or on the chip itself
        }
        // insertNode MOVES the chip — out of the old spot, into the word
        // gap under the cursor.
        target.insertNode(chip);
        placeCaretAfterChip(chip);
        setDraft(composerText(el));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onFinish);
      window.addEventListener("pointercancel", onCancel);
    },
    [],
  );

  const confirmRemoveAsk = useCallback(() => {
    if (!removingAsk) return;
    composerRef.current
      ?.querySelector(`[data-ask-chip="${removingAsk.key}"]`)
      ?.remove();
    setAsks((current) => current.filter((ask) => ask.key !== removingAsk.key));
    setRemovingAsk(null);
  }, [removingAsk]);

  const send = useCallback(() => {
    if (!conversation) return;
    const text = draft.trim();
    if (text.length === 0 && pendingImages.length === 0) return;

    // The message mirrors the composer in order: each ask quote sits
    // exactly where its chip was in the sentence. A reply still travels as
    // a leading quote (its chip lives above the composer).
    const quoteFor = (key: number) =>
      asks.find((ask) => ask.key === key)?.quote;
    const body = composerRef.current
      ? composerMessage(composerRef.current, quoteFor)
      : text;
    const sentText =
      replying && body.length > 0 ? `${replying.quote}\n\n${body}` : body;
    const sentImages = pendingImages;
    setDraft("");
    setPendingImages([]);
    clearAsks();
    setReplying(null);
    if (composerRef.current) composerRef.current.textContent = "";
    runCommand(conversation.id, "send_message", {
      content: sentText,
      images: sentImages,
    });
  }, [conversation, draft, pendingImages, asks, replying, clearAsks, runCommand]);

  const startEdit = useCallback((message: Message) => {
    const el = composerRef.current;
    if (el) {
      draftStashRef.current = composerText(el);
      el.textContent = message.content;
      el.focus();
    }
    setReplying(null);
    setAsks([]);
    setEditing({ id: message.id, content: message.content });
    setDraft(message.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    const el = composerRef.current;
    if (el) el.textContent = draftStashRef.current;
    setDraft(draftStashRef.current);
  }, []);

  const submitEdit = useCallback(() => {
    if (!conversation || !editing) return;
    const el = composerRef.current;
    const text = (el ? composerText(el) : "").trim();
    if (text.length === 0) return;
    setEditing(null);
    if (el) el.textContent = "";
    setDraft("");
    runCommand(conversation.id, "edit_message", {
      messageId: editing.id,
      content: text,
    });
  }, [conversation, editing, runCommand]);

  const regenerate = useCallback(() => {
    if (!conversation) return;
    runCommand(conversation.id, "regenerate", {});
  }, [conversation, runCommand]);

  /** Persists the reaction choice resolved by the menu (emoji or clear). */
  const react = useCallback(async (messageId: number, emoji: string | null) => {
    try {
      await invoke("set_reaction", { messageId, reaction: emoji });
      setMessages((current) =>
        current.map((m) => (m.id === messageId ? { ...m, reaction: emoji } : m)),
      );
    } catch (err) {
      console.error("Failed to set reaction:", err);
    }
  }, []);

  /** Opens the reply chip above the composer: a gray italic snippet of the
   * message; the full quote joins the sent message. */
  const replyTo = useCallback((message: Message) => {
    setEditing(null);
    setReplying({
      id: message.id,
      snippet: snippetOf(message.content),
      quote: quoteOf(message.content),
    });
    composerRef.current?.focus();
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await invoke("delete_message", { messageId: target.id });
      setMessages((current) => current.filter((m) => m.id !== target.id));
    } catch (err) {
      console.error("Failed to delete message:", err);
    }
  }, [deleting]);

  /** Forks the conversation at this message and jumps into the new one. */
  const forkFrom = useCallback(
    async (message: Message) => {
      if (!conversation) return;
      try {
        const forked = await invoke<Conversation>("fork_conversation", {
          conversationId: conversation.id,
          messageId: message.id,
        });
        onConversationsChanged();
        onSelectConversation(forked.id);
      } catch (err) {
        console.error("Failed to fork conversation:", err);
      }
    },
    [conversation, onConversationsChanged, onSelectConversation],
  );

  // --- Header title rename ------------------------------------------------

  const startTitleEdit = useCallback(() => {
    if (!conversation) return;
    titleCancelledRef.current = false;
    setTitleDraft(conversation.title);
    setTitleEditing(true);
  }, [conversation]);

  const saveTitle = useCallback(async () => {
    if (!conversation) return;
    setTitleEditing(false);
    const title = titleDraft.trim();
    if (titleCancelledRef.current || title.length === 0 || title === conversation.title) {
      return;
    }
    try {
      await invoke("rename_conversation", { id: conversation.id, title });
      onConversationsChanged();
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  }, [conversation, titleDraft, onConversationsChanged]);

  // The composer is uncontrolled: after any edit (typing, chip click,
  // Backspace-removed chip) mirror the DOM back into state.
  const syncComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    setDraft(composerText(el));
    const domKeys = new Set(
      Array.from(el.querySelectorAll("[data-ask-chip]")).map((chip) =>
        Number(chip.getAttribute("data-ask-chip")),
      ),
    );
    setAsks((current) => current.filter((ask) => domKeys.has(ask.key)));
  }, []);

  // Flush loop while streaming — keeps renders batched, typing responsive.
  useEffect(() => {
    if (stream === null) return;
    const timer = window.setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [stream !== null, flushBuffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump-to-message (from search): once the target conversation's thread is
  // on screen, scroll it into view and flash a highlight.
  useEffect(() => {
    if (!jumpTarget) return;
    if (
      !conversation ||
      conversation.id !== jumpTarget.conversationId ||
      messages.length === 0
    ) {
      return;
    }
    const el = scrollRef.current?.querySelector(
      `[data-message-id="${jumpTarget.messageId}"]`,
    );
    if (!el) return; // deleted in the meantime — nothing to jump to
    stickToBottomRef.current = false;
    el.scrollIntoView({ block: "center" });
    setHighlightId(jumpTarget.messageId);
    const timer = window.setTimeout(() => setHighlightId(null), 10_000);
    onJumpHandled();
    return () => window.clearTimeout(timer);
  }, [jumpTarget, messages, conversation, onJumpHandled]);

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
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-5 py-2.5">
        {!sidebarOpen && <ShowSidebarButton onClick={onOpenSidebar} />}
        {titleEditing ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void saveTitle();
              } else if (event.key === "Escape") {
                titleCancelledRef.current = true;
                setTitleEditing(false);
              }
            }}
            maxLength={120}
            aria-label="Conversation title"
            className="min-w-0 flex-1 rounded-md border border-input bg-input px-2 py-1 text-sm outline-none"
          />
        ) : (
          <h2
            onClick={startTitleEdit}
            title="Rename conversation"
            className="cursor-text truncate rounded-md px-1 text-sm font-semibold hover:bg-muted/60"
          >
            {conversation.title}
          </h2>
        )}
        {!detailsOpen && (
          <div className="ml-auto shrink-0">
            <ShowDetailsButton onClick={onOpenDetails} />
          </div>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
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
              <MessageView
                key={message.id}
                message={message}
                highlighted={message.id === highlightId}
                showRegenerate={
                  !isStreaming &&
                  message.role === "assistant" &&
                  message.id === lastMessageId
                }
                onRegenerate={regenerate}
                onEdit={message.role === "user" ? () => startEdit(message) : undefined}
                onReact={(emoji) => void react(message.id, emoji)}
                onReply={() => replyTo(message)}
                onDelete={() => setDeleting(message)}
                onFork={() => void forkFrom(message)}
              />
            ))}
            {isStreaming && <StreamingMessage stream={stream} />}
            {error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                <span className="min-w-0 flex-1 text-xs text-destructive">
                  {error}
                </span>
                {!isStreaming && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={regenerate}
                    aria-label="Retry"
                    title="Retry"
                    className="h-6 shrink-0 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-border p-4">
        {askButton && !isStreaming && !editing && (
          <button
            type="button"
            style={{ top: askButton.top, left: askButton.left }}
            // Keep the selection alive until the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => askAbout(askButton.text)}
            className="animate-pop-in fixed z-50 rounded-full border border-border bg-popover px-3 py-1 text-xs shadow-md hover:bg-accent"
          >
            Ask about it
          </button>
        )}
        {isStreaming && (
          <div className="mb-2 flex items-center gap-2 px-1 text-muted-foreground">
            <AgentLoader type="orbit" dotClassName="h-[3px] w-[3px]" />
            <span className="text-xs italic">Discombobulating...</span>
          </div>
        )}
        {editing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Editing your message — sending continues the conversation from here
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-5 w-5 shrink-0 text-muted-foreground"
              onClick={cancelEdit}
              disabled={isStreaming}
              aria-label="Cancel editing"
              title="Cancel editing"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {replying && !editing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs">
            <Reply className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate italic text-muted-foreground">
              {replying.snippet}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-5 w-5 shrink-0 text-muted-foreground"
              onClick={() => setReplying(null)}
              disabled={isStreaming}
              aria-label="Cancel reply"
              title="Cancel reply"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {!editing && (
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
          )}
          <div className="min-w-0 flex-1 rounded-lg border border-border bg-card">
            {!editing && (
              <PendingImages
                images={pendingImages}
                onRemove={(index) =>
                  setPendingImages((current) =>
                    current.filter((_, i) => i !== index),
                  )
                }
              />
            )}
            <div className="relative flex items-end gap-1 px-2 py-1">
              {draft.length === 0 && asks.length === 0 && (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {editing ? "Edit your message…" : "Write a message…"}
                </span>
              )}
              <div
                ref={composerRef}
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-label={editing ? "Edit message" : "Message"}
                onInput={syncComposer}
                onPointerDown={(event) => {
                  // Grabbing a chip starts the pointer drag; preventDefault
                  // keeps the editable from also starting a text selection.
                  const chip = (event.target as HTMLElement).closest(
                    "[data-ask-chip]",
                  );
                  if (!chip || !composerRef.current?.contains(chip)) return;
                  event.preventDefault();
                  beginAskDrag(event, chip as HTMLElement);
                }}
                onClick={(event) => {
                  // Clicking an ask chip opens the removal confirmation —
                  // unless the pointer just finished a drag.
                  if (suppressChipClickRef.current) {
                    suppressChipClickRef.current = false;
                    return;
                  }
                  const chip = (event.target as HTMLElement).closest(
                    "[data-ask-chip]",
                  );
                  if (!chip || !composerRef.current?.contains(chip)) return;
                  setRemovingAsk({
                    key: Number(chip.getAttribute("data-ask-chip")),
                    snippet:
                      chip.querySelector("span")?.textContent ??
                      "quoted selection",
                  });
                }}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter inserts a newline; Escape
                  // leaves edit / reply mode and drops the ask chips.
                  if (
                    event.key === "Escape" &&
                    !event.nativeEvent.isComposing
                  ) {
                    if (editing) {
                      event.preventDefault();
                      cancelEdit();
                      return;
                    }
                    if (replying) {
                      event.preventDefault();
                      setReplying(null);
                      return;
                    }
                    if (asks.length > 0) {
                      event.preventDefault();
                      clearAsks();
                      return;
                    }
                  }
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (editing) {
                      submitEdit();
                    } else {
                      send();
                    }
                  }
                }}
                onPaste={(event) => {
                  // Plain text only — the composer must not turn into a
                  // rich-text document.
                  event.preventDefault();
                  const text = event.clipboardData.getData("text/plain");
                  if (text.length > 0) {
                    document.execCommand("insertText", false, text);
                  }
                }}
                className="max-h-40 min-h-7 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-sm outline-none"
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
                  onClick={() => (editing ? submitEdit() : send())}
                  disabled={draft.trim().length === 0 && pendingImages.length === 0}
                  aria-label={editing ? "Save edit" : "Send"}
                  title={editing ? "Save edit (Enter)" : "Send (Enter)"}
                >
                  {editing ? <Pencil /> : <SendHorizontal />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </footer>

      {/* Delete-message confirmation */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
            <DialogDescription>
              This message will be permanently removed from the conversation.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ask-chip removal confirmation */}
      <Dialog
        open={removingAsk !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingAsk(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove quoted selection?</DialogTitle>
            <DialogDescription>
              “{removingAsk?.snippet}” will no longer travel with your
              message.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemovingAsk(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemoveAsk}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
