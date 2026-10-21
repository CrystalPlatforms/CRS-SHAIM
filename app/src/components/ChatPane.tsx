import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  PanelLeftOpen,
  PanelRightOpen,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  SendHorizontal,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from "lucide-react";

import type {
  AgentKind,
  ChatStreamEvent,
  Conversation,
  Message,
  ModelInfo,
  Server,
  SkillInfo,
  StoredSkill,
  StreamSegment,
} from "@/types";
import { AGENT_COMMANDS, isReasoningTitle } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageView, PendingImages } from "@/components/MessageView";
import { StreamingText } from "@/components/StreamingText";
import { StreamStatus } from "@/components/loaders/StreamStatus";
import { AgentLoader } from "@/components/loaders/AgentLoader";
import { ActivityBlock } from "@/components/ActivityBlock";
import { paletteSelection, skillRows } from "@/lib/skillPalette";
import { extractLastShaimTodos, parseTodoWrite, type TodoItem } from "@/lib/shaimBlocks";
import { GoalProgressWidget } from "@/components/GoalProgress";
import { cn } from "@/lib/utils";

interface ChatPaneProps {
  conversation: Conversation | null;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  detailsOpen: boolean;
  onOpenDetails: () => void;
  /** Notifies the parent when auto-title (or anything else) changed the list. */
  onConversationsChanged: () => void;
  /** Deletes a conversation (issue #27) — the parent clears the selection
   * and drops the sidebar badges with it. */
  onDelete: (id: number) => Promise<void> | void;
  /** Selects another conversation — used after a fork. */
  onSelectConversation: (id: number) => void;
  /** Pending "scroll to this message" request from a search hit. */
  jumpTarget: { conversationId: number; messageId: number } | null;
  /** Acknowledges the jump once it has been performed. */
  onJumpHandled: () => void;
  /** Reports background work — the sidebar badges conversations that are
   * still generating after the user switched away (issue #21). */
  onStreamingChanged: (conversationId: number, streaming: boolean) => void;
  /** Reports a conversation's error state — the sidebar shows the error
   * mark next to chats that failed until the next send clears it. */
  onErrorChanged: (conversationId: number, hasError: boolean) => void;
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

/** An in-flight stream: natural-mode thinking plus the ordered pieces
 * (assistant text, activity blocks) both modes produce. */
interface StreamState {
  thinking: string;
  segments: StreamSegment[];
}

/** One permission ask waiting for the user's decision (issue #28). */
interface PermissionAsk {
  requestId: string;
  toolName: string;
  target: string;
}

/** One conversation's in-flight generation (issue #21): the buffer keeps
 * filling while the user reads another chat, and coming back resumes the
 * live view from exactly where the stream stands. */
interface ConversationStream {
  buffer: StreamState;
  streaming: boolean;
  generationId: number | null;
  /** The last failure — resurfaced when the conversation is reopened. */
  error: string | null;
  /** The open permission ask (issue #28) — resurfaced on reopen too. */
  permission: PermissionAsk | null;
  /** Assistant-enqueued follow-ups (shaim-queue, issue #22) waiting to be
   * sent. Mid-run they ride the brain's live session; after it, the next
   * generation. */
  queue: string[];
  /** Which send pipeline the queue rides on — set by the last send(). */
  sendMode: "agent" | "chat";
  /** Stop already requested for this run to hand the queue its turn —
   * one stop per run, even if more step boundaries scroll by. */
  steerStop: boolean;
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

/** One row of the composer suggestion palette. `skillId` marks a one-shot
 * Shaim library skill — picking it attaches the skill to the next send
 * instead of inserting text (those rows carry no insert text). */
interface SuggestionItem {
  label: string;
  hint?: string;
  insert?: string;
  skillId?: number;
}

/** Open palette state: what kind, the trigger token length (the query plus
 * the "/" or "@" that started it) and the rows. */
interface SuggestionState {
  kind: "command" | "file";
  tokenLength: number;
  items: SuggestionItem[];
  selected: number;
}

/** Snippet for the reply chip: the first non-empty line, char-safe cut. */
function snippetOf(content: string): string {  const MAX = 64;
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

/** Compact folder label for the toolbar: the parent plus the active
 * folder ("../LOGOs/Metredon"); anything longer collapses to "…". */
function folderLabel(path: string | null): string {
  if (!path) return "Choose folder…";
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  const short = `../${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return short.length > 26 ? `…${short.slice(-25)}` : short;
}

/** The most recent activity segment — where appends and closes land. */
function lastActivity(segments: StreamSegment[]): Extract<StreamSegment, { kind: "activity" }> | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.kind === "activity") return segment;
  }
  return null;
}

/** The assistant's latest goal-progress state from the live buffer (issue
 * #22): the newest TodoWrite activity or shaim-todos block wins. Reading
 * backwards keeps the widget on "what the agent is doing now". */
function latestTodos(segments: StreamSegment[]): TodoItem[] | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.kind === "activity") {
      const todos = parseTodoWrite(segment.detail);
      if (todos) return todos;
    } else {
      const todos = extractLastShaimTodos(segment.text);
      if (todos) return todos;
    }
  }
  return null;
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

/** Builds the inline one-shot skill chip: the skill's name in terminal
 * (monospace) font inside a small rectangle. Display only — the skill's
 * CONTENT travels through the backend injection, never through the message
 * text. Lives inside the composer as a non-editable element; draggable like
 * an ask chip, click asks for removal. */
function buildSkillChip(name: string): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute("data-skill-chip", name);
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute("title", "Drag to move · click to remove");
  chip.className =
    "mr-0.5 inline-flex cursor-pointer select-none items-center rounded-[4px] border border-primary/40 bg-primary/10 px-1.5 py-0.5 align-middle font-mono text-xs text-foreground";
  chip.textContent = `/${name}`;
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
    if (element.hasAttribute("data-skill-chip")) return;
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
    if (element.hasAttribute("data-skill-chip")) return;
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

/** One half of the Natural/Agent mode selector. Shared with the Details
 * panel, which offers the same switch. */
export function ModePill({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted/40"
      )}
    >
      {label}
    </button>
  );
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
  onDelete,
  onSelectConversation,
  jumpTarget,
  onJumpHandled,
  onStreamingChanged,
  onErrorChanged,
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
  /** A skill chip the user clicked — waiting for removal confirmation
   * (holds the skill's name; only one chip can exist at a time). */
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  /** The conversation waiting for delete confirmation (issue #27) — the
   * header's Delete button opens the same Enter-confirms dialog the
   * sidebar uses. */
  const [deletingConversation, setDeletingConversation] = useState<Conversation | null>(null);
  /** Slash-command / @-file palette above the composer (Agent mode). */
  const [suggestions, setSuggestions] = useState<SuggestionState | null>(null);
  /** Which composer toolbar popover is open. */
  const [composerPopup, setComposerPopup] = useState<
    "brain" | "model" | "folder" | null
  >(null);
  /** Skills installed for the conversation's CLI brain. */
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  /** Shaim's own skill library — the "/" palette lists it in every mode. */
  const [librarySkills, setLibrarySkills] = useState<StoredSkill[]>([]);
  /** Skill invoked from the palette: attaches ONE-SHOT to the next send,
   * independent of the skill's global enable toggle. */
  const [invokedSkill, setInvokedSkill] = useState<{ id: number; name: string } | null>(
    null,
  );
  /** The displayed conversation's open permission ask (issue #28) — while
   * one stands, the composer swaps to the allow buttons. */
  const [permission, setPermission] = useState<PermissionAsk | null>(null);
  /** The displayed conversation's queued follow-ups (issue #22). */
  const [queue, setQueue] = useState<string[]>([]);
  /** The assistant's latest goal-progress state (issue #22) — the pinned
   * widget above the composer, only while this chat is streaming. */
  const [streamTodos, setStreamTodos] = useState<TodoItem[] | null>(null);

  /** Per-conversation in-flight generations (issue #21): switching chats
   * never interrupts one. Each entry owns its buffer, generation id and
   * error; the `stream`/`error` state below are only the displayed
   * conversation's window onto its entry. */
  const streamsRef = useRef<Map<number, ConversationStream>>(new Map());
  /** The conversation currently on screen — stream events always land in
   * their own conversation's entry, but only the displayed one mirrors
   * into component state. */
  const displayedIdRef = useRef<number | null>(null);
  /** Guards stale '@' file queries — only the newest detection wins. */
  const suggestionRequestIdRef = useRef(0);
  /** Queue flusher, wired after runCommand (the stream handler fires it). */
  const flushQueueRef = useRef<((conversationId: number) => void) | null>(null);

  const isCliBrain = conversation?.agent_kind != null;

  // Skills of the current brain — the "/" palette merges them in, "$"
  // shows them alone. The Shaim library rides in every mode; switching
  // conversations drops a pending one-shot attach.
  useEffect(() => {
    setInvokedSkill(null);
    const kind = conversation?.agent_kind;
    if (!kind) {
      setSkills([]);
    } else {
      let cancelled = false;
      invoke<SkillInfo[]>("list_agent_skills", { agentKind: kind })
        .then((loaded) => {
          if (!cancelled) setSkills(loaded);
        })
        .catch(() => {
          if (!cancelled) setSkills([]);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [conversation?.id, conversation?.agent_kind]);
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      invoke<StoredSkill[]>("list_skills")
        .then((loaded) => {
          if (!cancelled) setLibrarySkills(loaded);
        })
        .catch(() => {
          if (!cancelled) setLibrarySkills([]);
        });
    };
    reload();
    // Settings → Skills broadcasts after every change (toggle, import,
    // edit, delete) so the palette never offers a stale set.
    window.addEventListener("shaim:skills-changed", reload);
    return () => {
      cancelled = true;
      window.removeEventListener("shaim:skills-changed", reload);
    };
  }, [conversation?.id]);
  /** The conversation's stream entry, created on first use. */
  const entryFor = useCallback((conversationId: number): ConversationStream => {
    let entry = streamsRef.current.get(conversationId);
    if (!entry) {
      entry = {
        buffer: { thinking: "", segments: [] },
        streaming: false,
        generationId: null,
        error: null,
        permission: null,
        queue: [],
        sendMode: "chat",
        steerStop: false,
      };
      streamsRef.current.set(conversationId, entry);
    }
    return entry;
  }, []);
  const composerRef = useRef<HTMLDivElement>(null);
  /** Scrollable palette dropdown — arrow keys keep the selection in view. */
  const paletteRef = useRef<HTMLDivElement>(null);
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

  // Load the thread whenever the selected conversation changes. A
  // generation left running in the background (issue #21) keeps going —
  // the live view resumes from its buffer the moment the chat reopens.
  useEffect(() => {
    displayedIdRef.current = conversation?.id ?? null;
    stickToBottomRef.current = true;
    setMessages([]);
    setStream(null);
    setError(null);
    setPendingImages([]);
    setDraft("");
    setPermission(null);
    setQueue([]);
    setStreamTodos(null);
    if (composerRef.current) composerRef.current.textContent = "";
    setEditing(null);
    setReplying(null);
    setAsks([]);
    setAskButton(null);
    setDeleting(null);
    setSuggestions(null);
    if (!conversation) return;

    // Still working? Show the live stream again, exactly where it stands.
    const entry = streamsRef.current.get(conversation.id);
    if (entry?.streaming) {
      setStream({
        thinking: entry.buffer.thinking,
        segments: [...entry.buffer.segments],
      });
      setStreamTodos(latestTodos(entry.buffer.segments));
    }
    if (entry?.error) setError(entry.error);
    if (entry?.permission) setPermission(entry.permission);
    if (entry && entry.queue.length > 0) setQueue([...entry.queue]);

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

  /** Copies the DISPLAYED conversation's buffer into render state — the
   * flush loop that keeps typing responsive while a stream runs. */
  const flushBuffer = useCallback(() => {
    const id = displayedIdRef.current;
    if (id === null) return;
    const entry = streamsRef.current.get(id);
    if (!entry?.streaming) return;
    setStream({
      thinking: entry.buffer.thinking,
      segments: [...entry.buffer.segments],
    });
    setStreamTodos(latestTodos(entry.buffer.segments));
  }, []);

  const reloadMessages = useCallback(async (conversationId: number) => {
    try {
      setMessages(await invoke<Message[]>("list_messages", { conversationId }));
    } catch (err) {
      console.error("Failed to reload messages:", err);
    }
  }, []);

  /** Stops the DISPLAYED conversation's generation — background ones keep
   * running until their own chat is reopened and stopped there. */
  const stop = useCallback(async () => {
    const id = displayedIdRef.current;
    if (id === null) return;
    const generationId = streamsRef.current.get(id)?.generationId ?? null;
    if (generationId === null) return;
    try {
      await invoke("stop_generation", { generationId });
    } catch (err) {
      console.error("Failed to stop generation:", err);
    }
  }, []);

  /**
   * Runs one chat/agent command (send_message / send_agent_message /
   * regenerate / edit_message) and drives its stream. Natural mode converges
   * on "history as stored → one streamed assistant message appended"; agent
   * mode streams many segments and finishes with a full history push.
   *
   * Every event lands in the running conversation's own entry (issue #21),
   * so switching chats never mixes threads; only the displayed conversation
   * also mirrors into component state.
   */
  const runCommand = useCallback(
    (conversationId: number, command: string, args: Record<string, unknown>) => {
      const entry = entryFor(conversationId);
      if (entry.streaming) return;
      entry.buffer = { thinking: "", segments: [] };
      entry.error = null;
      entry.generationId = null;
      entry.streaming = true;
      entry.permission = null;
      onStreamingChanged(conversationId, true);
      onErrorChanged(conversationId, false);
      setError(null);
      if (displayedIdRef.current === conversationId) {
        setStream({ thinking: "", segments: [] });
        setPermission(null);
        setStreamTodos(null);
        // Sending always means "show me the latest" — even if the user had
        // scrolled up, ride down to the new message.
        stickToBottomRef.current = true;
        scrollToBottom(true);
      }

      const channel = new Channel<ChatStreamEvent>();
      channel.onmessage = (event) => {
        // Stable for the conversation's lifetime — closures capture it.
        const live = entry;
        switch (event.type) {
          case "user_message":
            // A background conversation's thread reloads from the store on
            // switch — only the on-screen one needs the live append.
            if (displayedIdRef.current === conversationId) {
              setMessages((current) => [
                ...current,
                {
                  id: event.id,
                  conversation_id: conversationId,
                  role: "user",
                  content: event.content,
                  thinking: null,
                  images: event.images,
                  skill_name: event.skill_name,
                  created_at: Math.floor(Date.now() / 1000),
                },
              ]);
            }
            break;
          case "history":
            // The store rewrote the path (edit truncation, regenerate
            // removal, agent persistence) — mirror the canonical history.
            if (displayedIdRef.current === conversationId) {
              setMessages(event.messages);
            }
            break;
          case "started":
            // The id arrives before the stream does — Stop works mid-flight
            // (the command itself only returns once everything finished).
            live.generationId = event.generation_id;
            // Every generation — composer-sent or queue-flushed — gets a
            // clean shot at handing the queue its turn at the first step
            // boundary.
            live.steerStop = false;
            break;
          case "thinking":
            live.buffer.thinking += event.text;
            break;
          case "content": {
            // Natural mode appends to the streamed text; agent mode opens a
            // new text piece after each activity block.
            const segments = live.buffer.segments;
            const last = segments[segments.length - 1];
            if (last?.kind === "text") {
              last.text += event.text;
            } else {
              segments.push({ kind: "text", text: event.text });
            }
            break;
          }
          case "activity_start":
            live.buffer.segments.push({
              kind: "activity",
              title: event.title,
              detail: "",
              open: true,
            });
            break;
          case "activity_append": {
            const target = lastActivity(live.buffer.segments);
            if (target) target.detail += event.detail;
            break;
          }
          case "activity_retitle": {
            const target = lastActivity(live.buffer.segments);
            if (target) target.title = event.title;
            break;
          }
          case "activity_end": {
            const target = lastActivity(live.buffer.segments);
            if (target) target.open = false;
            // A step just closed and something is queued (issue #22
            // follow-up): stop this run right at the clean boundary — the
            // end-of-run flush then sends the queue head as the next
            // generation. Works for every brain (Claude, Codex, server).
            if (live.queue.length > 0 && !live.steerStop && live.generationId != null) {
              live.steerStop = true;
              const generationId = live.generationId;
              invoke("stop_generation", { generationId }).catch(() => {
                // Stop failed — the run continues, the next step boundary
                // gets another chance.
                live.steerStop = false;
              });
            }
            break;
          }
          case "permission_request":
            // The composer swaps to the allow buttons until the user
            // answers (issue #28). Background conversations resurface the
            // ask when reopened.
            live.permission = {
              requestId: event.request_id,
              toolName: event.tool_name,
              target: event.target,
            };
            if (displayedIdRef.current === conversationId) {
              setPermission(live.permission);
            }
            break;
          case "title_changed":
            onConversationsChanged();
            break;
          case "done": {
            live.streaming = false;
            live.generationId = null;
            live.permission = null;
            if (displayedIdRef.current === conversationId) {
              setMessages((current) => [
                ...current,
                {
                  id: event.message_id,
                  conversation_id: conversationId,
                  role: "assistant",
                  content: event.content,
                  thinking: event.thinking.length > 0 ? event.thinking : null,
                  images: [],
                  skill_name: null,
                  created_at: Math.floor(Date.now() / 1000),
                },
              ]);
              setStream(null);
              setPermission(null);
              setStreamTodos(null);
            }
            // The user's queued messages (issue #22) go out once the
            // generation finished naturally — never mid-work, never after
            // Stop or an error.
            if (!event.aborted && live.queue.length > 0) {
              window.setTimeout(() => flushQueueRef.current?.(conversationId), 700);
            }
            onStreamingChanged(conversationId, false);
            if (event.aborted) onConversationsChanged();
            break;
          }
          case "agent_done": {
            // The persisted segments already arrived as a history push.
            live.streaming = false;
            live.generationId = null;
            live.permission = null;
            if (displayedIdRef.current === conversationId) {
              setStream(null);
              setPermission(null);
              setStreamTodos(null);
              if (event.error) setError(event.error);
            }
            if (event.error) live.error = event.error;
            if (!event.error && live.queue.length > 0) {
              window.setTimeout(() => flushQueueRef.current?.(conversationId), 700);
            }
            onStreamingChanged(conversationId, false);
            onErrorChanged(conversationId, event.error != null);
            onConversationsChanged();
            break;
          }
          case "error": {
            live.streaming = false;
            live.generationId = null;
            live.error = event.message;
            live.permission = null;
            if (displayedIdRef.current === conversationId) {
              setError(event.message);
              setStream(null);
              setPermission(null);
              setStreamTodos(null);
              // A failed/partial stream persists what arrived — reload to
              // show it.
              void reloadMessages(conversationId);
            }
            onStreamingChanged(conversationId, false);
            onErrorChanged(conversationId, true);
            break;
          }
        }
      };

      invoke<number>(command, { conversationId, ...args, channel })
        .then((id) => {
          entry.generationId = id;
        })
        .catch((err) => {
          entry.streaming = false;
          entry.generationId = null;
          entry.error = String(err);
          onStreamingChanged(conversationId, false);
          onErrorChanged(conversationId, true);
          if (displayedIdRef.current === conversationId) {
            setStream(null);
            setError(String(err));
          }
          onConversationsChanged();
        });
    },
    [entryFor, onConversationsChanged, onErrorChanged, onStreamingChanged, reloadMessages, scrollToBottom],
  );

  /** Sends the head of the assistant's queue (issue #22) — called from the
   * stream handler after a generation ends; each send streams on its own. */
  const flushQueue = useCallback(
    (conversationId: number) => {
      const entry = streamsRef.current.get(conversationId);
      if (!entry || entry.streaming || entry.queue.length === 0) return;
      const text = entry.queue.shift() ?? "";
      if (displayedIdRef.current === conversationId) setQueue([...entry.queue]);
      runCommand(
        conversationId,
        entry.sendMode === "agent" ? "send_agent_message" : "send_message",
        { content: text, images: [], skillId: null },
      );
    },
    [runCommand],
  );
  useEffect(() => {
    flushQueueRef.current = flushQueue;
  }, [flushQueue]);

  /** Removes one queued follow-up before it goes out. */
  const removeQueued = useCallback((index: number) => {
    const id = displayedIdRef.current;
    if (id === null) return;
    const entry = streamsRef.current.get(id);
    if (!entry) return;
    entry.queue.splice(index, 1);
    setQueue([...entry.queue]);
  }, []);

  /** A queued chip the user clicked — opens the edit dialog. */
  const [editingQueued, setEditingQueued] = useState<number | null>(null);
  const [queuedDraft, setQueuedDraft] = useState("");

  const openQueuedEdit = useCallback((index: number) => {
    const entry = displayedIdRef.current !== null
      ? streamsRef.current.get(displayedIdRef.current)
      : undefined;
    if (!entry) return;
    setQueuedDraft(entry.queue[index] ?? "");
    setEditingQueued(index);
  }, []);

  /** Saves the edited queued message in place — order is untouched. */
  const saveQueuedEdit = useCallback(() => {
    const id = displayedIdRef.current;
    if (id === null || editingQueued === null) return;
    const entry = streamsRef.current.get(id);
    const text = queuedDraft.trim();
    if (entry && text.length > 0) {
      entry.queue[editingQueued] = text;
      setQueue([...entry.queue]);
    }
    setEditingQueued(null);
  }, [editingQueued, queuedDraft]);

  /** The user's answer to a permission ask (issue #28): the backend writes
   * the decision to the waiting agent; `remember` stores a standing rule. */
  const answerPermission = useCallback(
    async (ask: PermissionAsk, allow: boolean, remember: "conversation" | "global" | null) => {
      const id = displayedIdRef.current;
      const entry = id !== null ? streamsRef.current.get(id) : undefined;
      if (entry) entry.permission = null;
      setPermission(null);
      try {
        await invoke("respond_permission", {
          requestId: ask.requestId,
          allow,
          remember,
          conversationId: id,
        });
      } catch (err) {
        console.error("Failed to answer permission:", err);
        setError(String(err));
      }
    },
    [],
  );

  /** Drops every ask chip — DOM first, then the mirrored state. */
  const clearAsks = useCallback(() => {
    composerRef.current
      ?.querySelectorAll("[data-ask-chip]")
      .forEach((chip) => chip.remove());
    setAsks([]);
  }, []);

  /** Typed text between the composer start and the caret. */
  const textBeforeCaret = useCallback((): string => {
    const el = composerRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      return "";
    }
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return pre.toString();
  }, []);

  /** Opens the "/" palette (Shaim library skills in EVERY mode, plus the
   * CLI's built-in commands and installed skills where a CLI brain is set),
   * or the "@" file palette (Agent mode only) from the token under the
   * caret. Files resolve from the project folder with a short debounce —
   * the newest query always wins. */
  const detectSuggestion = useCallback(() => {
    if (!conversation) {
      setSuggestions(null);
      return;
    }
    const before = textBeforeCaret();
    const match = /(^|\s)([/@$])([^\s]*)$/.exec(before);
    if (!match) {
      setSuggestions(null);
      return;
    }
    const query = match[3].toLowerCase();
    const tokenLength = match[3].length + 1;
    const contains = (haystack: string) => haystack.toLowerCase().includes(query);
    if (match[2] === "@") {
      // Files of the project folder — Agent mode only.
      if (conversation.mode !== "agent" || !conversation.project_path) {
        setSuggestions(null);
        return;
      }
      const requestId = ++suggestionRequestIdRef.current;
      setSuggestions({ kind: "file", tokenLength, items: [], selected: 0 });
      window.setTimeout(() => {
        invoke<string[]>("list_project_files", {
          conversationId: conversation.id,
          query,
          limit: 20,
        })
          .then((files) => {
            if (suggestionRequestIdRef.current !== requestId) return;
            setSuggestions(
              files.length > 0
                ? {
                    kind: "file",
                    tokenLength,
                    items: files.map((file) => ({
                      label: `@${file}`,
                      hint: "mention this file",
                      insert: `@${file} `,
                    })),
                    selected: 0,
                  }
                : null,
            );
          })
          .catch(() => setSuggestions(null));
      }, 150);
      return;
    }
    if (match[2] === "$" && conversation.agent_kind == null) {
      setSuggestions(null);
      return;
    }
    const agentKind = conversation.agent_kind;
    // CLI rows (commands + the CLI's own installed skills) insert text for
    // the CLI to run; the Shaim library rows attach one-shot instead.
    const commandRows = (agentKind != null && match[2] === "/" ? AGENT_COMMANDS[agentKind] : [])
      .filter((entry) => query.length === 0 || contains(entry.cmd) || contains(entry.hint))
      .map((entry) => ({
        label: entry.cmd,
        hint: entry.hint,
        insert: `${entry.cmd} `,
      }));
    const cliSkillRows =
      agentKind != null
        ? skills
          .filter((skill) => query.length === 0 || contains(skill.name) || contains(skill.description))
          .map((skill) => ({
            label: `/${skill.name}`,
            hint: skill.description,
            insert: `/${skill.name} `,
          }))
      : [];
    const libraryRows = match[2] === "/" ? skillRows(librarySkills, query) : [];
    const items: SuggestionItem[] = [...commandRows, ...cliSkillRows, ...libraryRows];
    setSuggestions(
      items.length > 0
        ? { kind: "command", tokenLength, items, selected: 0 }
        : null,
    );
  }, [conversation, skills, librarySkills, textBeforeCaret]);

  /** Replaces the trigger token with the picked row and parks the caret
   * after the inserted text. */
  const applySuggestion = useCallback(
    (state: SuggestionState, item: SuggestionItem) => {
      const el = composerRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        setSuggestions(null);
        return;
      }
      const modifiable = sel as Selection & {
        modify?: (
          alteration: string,
          direction: string,
          granularity: string,
        ) => void;
      };
      if (modifiable.modify) {
        for (let i = 0; i < state.tokenLength; i++) {
          modifiable.modify("extend", "backward", "character");
        }
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (item.skillId != null) {
        // One-shot library skill: the token becomes an inline terminal-font
        // chip at the caret. The name never joins the message text — the
        // backend injects the skill's content into the request itself.
        const name = item.label.replace(/^\//, "");
        el.querySelectorAll("[data-skill-chip]").forEach((chip) => chip.remove());
        const chip = buildSkillChip(name);
        range.insertNode(chip);
        placeCaretAfterChip(chip);
        setInvokedSkill({ id: item.skillId, name });
        setDraft(composerText(el));
        setSuggestions(null);
        el.focus();
        return;
      }
      const inserted = document.createTextNode(item.insert ?? "");
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      setDraft(composerText(el));
      setSuggestions(null);
      el.focus();
    },
    [],
  );

  /**
   * Pointer-driven chip dragging (ask chips AND skill chips) — HTML5
   * drag&drop never fires a usable drop inside a contentEditable in WebKit.
   * The chip follows the pointer as a ghost, a green marker shows exactly
   * where the chip would land; on release it moves to the caret position
   * under the cursor. A release without movement stays a plain click (which
   * opens the removal dialog via the click handler).
   */
  const beginChipDrag = useCallback(
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

  const confirmRemoveSkill = useCallback(() => {
    setRemovingSkill(null);
    const el = composerRef.current;
    if (!el) return;
    // Only one skill chip can exist — drop it and the one-shot attach.
    el.querySelector("[data-skill-chip]")?.remove();
    setInvokedSkill(null);
    setDraft(composerText(el));
  }, []);

  const send = useCallback(() => {
    if (!conversation) return;
    if (conversation.mode === "agent" && !conversation.project_path) return;
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

    // While this chat generates, the message JOINS THE QUEUE (issue #22,
    // assistant-ui style): the agent reads it after the current work ends —
    // never in the middle of a step.
    if (streamsRef.current.get(conversation.id)?.streaming) {
      const entry = entryFor(conversation.id);
      entry.queue.push(body);
      setQueue([...entry.queue]);
      setDraft("");
      setPendingImages([]);
      clearAsks();
      setReplying(null);
      setInvokedSkill(null);
      setSuggestions(null);
      if (composerRef.current) composerRef.current.textContent = "";
      return;
    }

    const sentText =
      replying && body.length > 0 ? `${replying.quote}\n\n${body}` : body;
    const sentImages = pendingImages;
    const invokedSkillId = invokedSkill?.id;
    setDraft("");
    setPendingImages([]);
    clearAsks();
    setReplying(null);
    setInvokedSkill(null);
    setSuggestions(null);
    if (composerRef.current) composerRef.current.textContent = "";
    // Route by brain: server models in Natural chat through the gateway;
    // CLI brains and Agent mode (any brain) go through the agent pipeline.
    // An invoked skill is one-shot: it rides on exactly this send.
    const pipeline =
      conversation.mode === "agent" || conversation.agent_kind != null
        ? "agent"
        : "chat";
    entryFor(conversation.id).sendMode = pipeline;
    if (pipeline === "agent") {
      runCommand(conversation.id, "send_agent_message", {
        content: sentText,
        images: sentImages,
        skillId: invokedSkillId,
      });
    } else {
      runCommand(conversation.id, "send_message", {
        content: sentText,
        images: sentImages,
        skillId: invokedSkillId,
      });
    }
  }, [conversation, draft, pendingImages, asks, replying, invokedSkill, clearAsks, runCommand, entryFor]);

  /** Composer toolbar: Natural ↔ Agent, immediately — the folder, if
   * missing, is picked right where the folder button is. */
  const toggleMode = useCallback(async () => {
    if (!conversation) return;
    try {
      await invoke("set_conversation_mode", {
        id: conversation.id,
        mode: conversation.mode === "agent" ? "natural" : "agent",
      });
      onConversationsChanged();
    } catch (err) {
      console.error("Failed to switch mode:", err);
    }
  }, [conversation, onConversationsChanged]);

  /** Composer toolbar: repoints the project folder via the native picker. */
  const changeFolder = useCallback(async () => {
    if (!conversation) return;
    setComposerPopup(null);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string" || picked.length === 0) return;
      await invoke("set_conversation_agent", {
        id: conversation.id,
        agentKind: conversation.agent_kind,
        projectPath: picked,
      });
      onConversationsChanged();
    } catch (err) {
      console.error("Failed to change folder:", err);
    }
  }, [conversation, onConversationsChanged]);

  const startEdit = useCallback((message: Message) => {
    const el = composerRef.current;
    if (el) {
      draftStashRef.current = composerText(el);
      el.textContent = message.content;
      el.focus();
    }
    setReplying(null);
    setAsks([]);
    setInvokedSkill(null);
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
    // The conversation still generating keeps its edit queue closed.
    if (streamsRef.current.get(conversation.id)?.streaming) return;
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

  /** Confirms the header Delete (issue #27) — the parent owns the actual
   * deletion so the sidebar badges and selection drop with it. */
  const confirmDeleteConversation = useCallback(() => {
    if (!deletingConversation) return;
    const target = deletingConversation;
    setDeletingConversation(null);
    void onDelete(target.id);
  }, [deletingConversation, onDelete]);

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
    // A skill chip deleted with Backspace detaches the one-shot skill.
    setInvokedSkill((current) =>
      el.querySelector("[data-skill-chip]") != null ? current : null,
    );
  }, []);

  // Flush loop while streaming — keeps renders batched, typing responsive.
  useEffect(() => {
    if (stream === null) return;
    const timer = window.setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [stream !== null, flushBuffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys move the palette selection — scroll it into view when it
  // leaves the dropdown's visible slice (mouse users scroll themselves).
  useEffect(() => {
    if (!suggestions) return;
    const container = paletteRef.current;
    const selected = container?.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    if (!container || !selected) return;
    const top = selected.offsetTop;
    const bottom = top + selected.offsetHeight;
    if (top < container.scrollTop) {
      container.scrollTop = top;
    } else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight;
    }
  }, [suggestions]);

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

  /** Composer paperclip (issue #26): ONE picker for EVERY file. Agent
   * pipelines take the picked paths into the message so the CLI opens
   * exactly those files; Natural chat previews images inline and lists
   * other files by their path. */
  const browseAttachments = async () => {
    try {
      const picked = await open({ multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const agentPipeline =
        conversation && (conversation.mode === "agent" || conversation.agent_kind != null);
      if (agentPipeline) {
        composerRef.current?.focus();
        for (const path of paths) {
          document.execCommand("insertText", false, `${path}\n`);
        }
        if (composerRef.current) setDraft(composerText(composerRef.current));
        return;
      }
      // Natural chat: images become inline previews, the rest ride as paths.
      const previews: string[] = [];
      let insertedPath = false;
      for (const path of paths) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(path)) {
          try {
            previews.push(await invoke<string>("read_attachment_data_url", { path }));
            continue;
          } catch (err) {
            console.error("Failed to preview image:", err);
          }
        }
        composerRef.current?.focus();
        document.execCommand("insertText", false, `${path}\n`);
        insertedPath = true;
      }
      if (previews.length > 0) {
        setPendingImages((current) => [...current, ...previews]);
      }
      if (insertedPath && composerRef.current) {
        setDraft(composerText(composerRef.current));
      }
    } catch (err) {
      console.error("Failed to open file picker:", err);
    }
  };

  /** Paste: screenshots have no file, so one is saved and its path
   * inserted for agent brains; server chat keeps inline previews. */
  const attachImages = async (files: FileList | File[] | null) => {
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
      const agentPipeline =
        conversation && (conversation.mode === "agent" || conversation.agent_kind != null);
      if (agentPipeline) {
        composerRef.current?.focus();
        for (const dataUrl of dataUrls) {
          try {
            const path = await invoke<string>("save_attachment", { dataUrl });
            document.execCommand("insertText", false, `${path}\n`);
          } catch (err) {
            console.error("Failed to save attachment:", err);
          }
        }
        if (composerRef.current) setDraft(composerText(composerRef.current));
      } else {
        setPendingImages((current) => [...current, ...dataUrls]);
      }
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
  const isAgent = conversation.mode === "agent";
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
        {/* The header's own quick actions (issue #27): Rename starts the
            inline title edit, Delete asks before removing the chat. */}
        {!titleEditing && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={startTitleEdit}
              aria-label="Rename conversation"
              title="Rename conversation"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => setDeletingConversation(conversation)}
              aria-label="Delete conversation"
              title="Delete conversation"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            {!detailsOpen && <ShowDetailsButton onClick={onOpenDetails} />}
          </div>
        )}
        {titleEditing && !detailsOpen && (
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
                  !isAgent &&
                  !isCliBrain &&
                  !isStreaming &&
                  message.role === "assistant" &&
                  message.id === lastMessageId
                }
                onRegenerate={regenerate}
                onEdit={
                  !isAgent && !isCliBrain && message.role === "user"
                    ? () => startEdit(message)
                    : undefined
                }
                onReply={
                  message.role === "tool" ? undefined : () => replyTo(message)
                }
                onDelete={() => setDeleting(message)}
                onFork={
                  message.role === "tool"
                    ? undefined
                    : () => void forkFrom(message)
                }
              />
            ))}
            {isStreaming && <StreamingMessage stream={stream} />}
            {error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                <AgentLoader type="error" dotClassName="h-[3px] w-[3px]" className="shrink-0" />
                <span className="min-w-0 flex-1 text-xs text-destructive">
                  {error}
                </span>
                {!isStreaming && !isAgent && !isCliBrain && (
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
        {/* Always visible: the phase loader while streaming, Idle at rest. */}
        <StreamStatus
          stream={stream}
          brain={isCliBrain ? "cli" : "server"}
          className="mb-2 px-1"
          dotClassName="h-[3px] w-[3px]"
        />
        {/* The assistant's live goal progress (issue #22): pinned under the
            loader, above the input — what the agent is doing right now. */}
        {isStreaming && streamTodos && <GoalProgressWidget items={streamTodos} />}
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
        {/* Queued follow-ups (issue #22): the assistant's shaim-queue items
            wait here and go out one by one once the generation ends. */}
        {queue.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
            <span className="text-[11px] text-muted-foreground">
              Queued:
            </span>
            {queue.map((text, index) => (
              <button
                key={index}
                type="button"
                title="Click to edit · the agent reads it after the current step"
                onClick={() => openQueuedEdit(index)}
                className="inline-flex max-w-[280px] cursor-pointer items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] hover:border-primary/60"
              >
                <span className="min-w-0 truncate">{text}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove queued message ${index + 1}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeQueued(index);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.stopPropagation();
                      removeQueued(index);
                    }
                  }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        )}
        {/* Edit a queued message in place (issue #22 feedback): click the
            chip, change the text, save — order and removal stay untouched. */}
        <Dialog
          open={editingQueued !== null}
          onOpenChange={(open) => {
            if (!open) setEditingQueued(null);
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>Edit queued message</DialogTitle>
            </DialogHeader>
            <textarea
              value={queuedDraft}
              onChange={(event) => setQueuedDraft(event.target.value)}
              rows={4}
              aria-label="Queued message text"
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  saveQueuedEdit();
                }
              }}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditingQueued(null)}>
                Cancel
              </Button>
              <Button
                autoFocus
                disabled={queuedDraft.trim().length === 0}
                onClick={saveQueuedEdit}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <div className="flex items-end gap-2">
          {permission ? (
            <PermissionAskPanel
              ask={permission}
              onAnswer={(allow, remember) =>
                void answerPermission(permission, allow, remember)
              }
            />
          ) : (
          <div className="relative min-w-0 flex-1 rounded-lg border border-border bg-card transition-colors focus-within:border-primary/40">
            {/* Slash-command / @-file palette (every mode) */}
            {suggestions && suggestions.items.length > 0 && (
              <div
                ref={paletteRef}
                className="absolute bottom-full left-0 z-50 mb-1 max-h-52 w-full min-w-[280px] overflow-y-auto rounded-lg border border-border bg-popover shadow-md"
              >
                {suggestions.items.map((item, index) => (
                  <button
                    key={item.label}
                    type="button"
                    data-selected={index === suggestions.selected}
                    // Keep the caret in the composer for the insert.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySuggestion(suggestions, item);
                    }}
                    onMouseEnter={() =>
                      setSuggestions({ ...suggestions, selected: index })
                    }
                    className={cn(
                      "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs",
                      index === suggestions.selected && "bg-accent"
                    )}
                  >
                    <span className="shrink-0 font-medium">{item.label}</span>
                    {item.hint && (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {item.hint}
                      </span>
                    )}
                  </button>
                ))}
                <div className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
                  ↑↓ browse · Enter/Tab insert · Esc close
                </div>
              </div>
            )}
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
            <div className="relative px-2 pt-1">
              {draft.length === 0 && asks.length === 0 && !invokedSkill && (
                <span className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
                  {editing
                    ? "Edit your message…"
                    : isStreaming
                      ? "The agent is working — Enter queues your message for the next step…"
                      : isAgent
                        ? "Describe the task for the agent…"
                        : "Write a message…"}
                </span>
              )}
              <div
                ref={composerRef}
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-label={editing ? "Edit message" : "Message"}
                onInput={() => {
                  syncComposer();
                  detectSuggestion();
                }}
                onPointerDown={(event) => {
                  // Grabbing a chip (skill or ask) starts the pointer drag;
                  // preventDefault keeps the editable from also starting a
                  // text selection.
                  const chip = (event.target as HTMLElement).closest(
                    "[data-ask-chip], [data-skill-chip]",
                  );
                  if (!chip || !composerRef.current?.contains(chip)) return;
                  event.preventDefault();
                  beginChipDrag(event, chip as HTMLElement);
                }}
                onClick={(event) => {
                  // A pointer that just finished a drag must not open any
                  // removal dialog.
                  if (suppressChipClickRef.current) {
                    suppressChipClickRef.current = false;
                    return;
                  }
                  // Clicking a skill chip asks for confirmation first —
                  // same ritual as the ask chips.
                  const skillChip = (event.target as HTMLElement).closest(
                    "[data-skill-chip]",
                  );
                  if (skillChip && composerRef.current?.contains(skillChip)) {
                    setRemovingSkill(skillChip.getAttribute("data-skill-chip"));
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
                  // The suggestion palette eats navigation keys first.
                  if (suggestions && suggestions.items.length > 0) {
                    const count = suggestions.items.length;
                    if (
                      event.key === "ArrowDown" ||
                      event.key === "ArrowUp"
                    ) {
                      event.preventDefault();
                      const selected = paletteSelection(
                        event.key,
                        suggestions.selected,
                        count,
                      );
                      if (selected != null) {
                        setSuggestions({ ...suggestions, selected });
                      }
                      return;
                    }
                    if (
                      event.key === "Tab" ||
                      (event.key === "Enter" && !event.nativeEvent.isComposing)
                    ) {
                      event.preventDefault();
                      applySuggestion(
                        suggestions,
                        suggestions.items[paletteSelection(event.key, suggestions.selected, count) ?? suggestions.selected],
                      );
                      return;
                    }
                    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      setSuggestions(null);
                      return;
                    }
                  }
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
                  // Pasted screenshots become attachments: their PATH lands
                  // in the message for agent brains, previews for chat.
                  const imageFiles = Array.from(event.clipboardData.files).filter(
                    (file) => file.type.startsWith("image/"),
                  );
                  if (imageFiles.length > 0) {
                    event.preventDefault();
                    void attachImages(imageFiles);
                    return;
                  }
                  // Plain text only — the composer must not turn into a
                  // rich-text document.
                  event.preventDefault();
                  const text = event.clipboardData.getData("text/plain");
                  if (text.length > 0) {
                    document.execCommand("insertText", false, text);
                  }
                }}
                className="max-h-40 min-h-[60px] w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-sm outline-none"
              />
            </div>

            {/* Composer toolbar: brain, model, project folder — left side;
                send lives on the right. */}
            <div className="relative flex items-center gap-1 border-t border-border/60 px-2 py-1">
              {composerPopup && (
                <div
                  className="fixed inset-0 z-40"
                  onMouseDown={() => setComposerPopup(null)}
                />
              )}
              {composerPopup === "model" && (
                <ModelPopup
                  conversation={conversation}
                  onClose={() => setComposerPopup(null)}
                  onChanged={onConversationsChanged}
                />
              )}
              {composerPopup === "folder" && (
                <div className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-lg border border-border bg-popover p-2.5 shadow-md">
                  <div className="text-muted-foreground">Project folder</div>
                  <div className="mt-1 break-all font-mono text-[11px] text-foreground">
                    {conversation.project_path ?? "—"}
                  </div>
                  <Button
                    size="sm"
                    className="mt-2 h-7 px-2 text-xs"
                    onClick={() => void changeFolder()}
                  >
                    Change…
                  </Button>
                </div>
              )}

              {/* The paperclip (issue #26): borderless, lives inside the
                  input before the Mode button — one picker for every file. */}
              {!editing && (
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => void browseAttachments()}
                  aria-label="Attach files"
                  title="Attach files"
                  className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                disabled={isStreaming}
                onClick={() => void toggleMode()}
                title="Mode — Natural chats, Agent works in the project folder"
                className={cn(
                  "flex items-center rounded-md px-1.5 py-1 text-xs font-medium disabled:opacity-50",
                  isAgent
                    ? "text-yellow-500 hover:bg-yellow-500/10"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                {isAgent ? "Agent" : "Natural"}
              </button>
              <button
                type="button"
                disabled={isStreaming}
                onClick={() =>
                  setComposerPopup(composerPopup === "model" ? null : "model")
                }
                title="Model"
                className="flex items-center rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
              >
                Model
              </button>
              {conversation.mode === "agent" && (
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() =>
                    conversation.project_path
                      ? setComposerPopup(
                          composerPopup === "folder" ? null : "folder",
                        )
                      : void changeFolder()
                  }
                  title="Project folder"
                  className={cn(
                    "flex min-w-0 max-w-[190px] items-center rounded-md px-1.5 py-1 text-xs hover:bg-muted/50 disabled:opacity-50",
                    conversation.project_path
                      ? "text-muted-foreground"
                      : "text-foreground"
                  )}
                >
                  <span className="truncate">
                    {folderLabel(conversation.project_path)}
                  </span>
                </button>
              )}
              <div className="ml-auto">
                {isStreaming ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void stop()}
                    aria-label="Stop generating"
                    title="Stop generating"
                    className="animate-soft-pulse text-destructive transition-transform hover:scale-110 active:scale-95"
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => (editing ? submitEdit() : send())}
                    disabled={
                      (isAgent && !conversation.project_path) ||
                      (draft.trim().length === 0 && pendingImages.length === 0)
                    }
                    aria-label={editing ? "Save edit" : "Send"}
                    title={editing ? "Save edit (Enter)" : "Send (Enter)"}
                    className="transition-transform hover:scale-110 active:scale-95 disabled:hover:scale-100"
                  >
                    {editing ? <Pencil /> : <SendHorizontal />}
                  </Button>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
      </footer>

      {/* Delete-message confirmation — Enter lands on the destructive
          action, never on Cancel (issue #21). */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-conversation confirmation (issue #27) — the header's
          Delete button; Enter confirms, never cancels. */}
      <Dialog
        open={deletingConversation !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingConversation(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Delete conversation?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingConversation(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={confirmDeleteConversation}>
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
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Remove quoted selection?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemovingAsk(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={confirmRemoveAsk}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skill-chip removal confirmation */}
      <Dialog
        open={removingSkill !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingSkill(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Remove skill?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemovingSkill(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={confirmRemoveSkill}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** The composer "Model" popover: pick the provider — a CLI agent or one of
 * the configured servers — then the model that provider should run. */
function ModelPopup({
  conversation,
  onClose,
  onChanged,
}: {
  conversation: Conversation;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [servers, setServers] = useState<Server[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    invoke<Server[]>("list_servers")
      .then(setServers)
      .catch((error) => console.error("Failed to load servers:", error));
  }, []);

  const isCliBrain = conversation.agent_kind != null;
  const activeServerId = conversation.server_id ?? servers[0]?.id ?? null;

  // Models of the active provider: servers expose their own lists; the CLI
  // brains report their documented aliases plus the configured pick.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = isCliBrain
      ? invoke<string[]>("list_cli_models", {
          agentKind: conversation.agent_kind,
        })
      : activeServerId !== null
        ? invoke<ModelInfo[]>("list_server_models", { id: activeServerId }).then(
            (loaded) => loaded.map((model) => model.id),
          )
        : Promise.resolve([] as string[]);
    load
      .then((loaded) => {
        if (!cancelled) setModels(loaded);
      })
      .catch((error) => {
        console.error("Failed to load models:", error);
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCliBrain, conversation.agent_kind, activeServerId]);

  const pickProvider = async (provider: { kind: "server" | AgentKind; serverId?: number }) => {
    try {
      if (provider.kind === "server") {
        await invoke("set_conversation_brain", { id: conversation.id, agentKind: null });
        await invoke("set_conversation_model", {
          id: conversation.id,
          serverId: provider.serverId ?? null,
          modelId: null,
        });
      } else {
        await invoke("set_conversation_brain", {
          id: conversation.id,
          agentKind: provider.kind,
        });
      }
      onChanged();
    } catch (error) {
      console.error("Failed to switch provider:", error);
    }
  };

  const pickModel = async (model: string) => {
    try {
      await invoke("set_conversation_model", {
        id: conversation.id,
        serverId: conversation.server_id,
        modelId: model === "default" ? null : model,
      });
      onChanged();
      onClose();
    } catch (error) {
      console.error("Failed to set model:", error);
    }
  };

  const providers: {
    key: string;
    label: string;
    kind: "server" | AgentKind;
    serverId?: number;
    active: boolean;
  }[] = [
    { key: "claude_code", label: "Claude Code", kind: "claude_code", active: conversation.agent_kind === "claude_code" },
    { key: "codex", label: "Codex", kind: "codex", active: conversation.agent_kind === "codex" },
    ...servers.map((server) => ({
      key: `server-${server.id}`,
      label: server.name,
      kind: "server" as const,
      serverId: server.id,
      active:
        conversation.agent_kind == null &&
        (conversation.server_id === server.id ||
          (conversation.server_id === null && servers[0]?.id === server.id)),
    })),
  ];

  const currentModel = conversation.model_id ?? "default";

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div className="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-md">
        <div className="px-1 text-muted-foreground">Provider</div>
        <div className="mt-1 space-y-0.5">
          {providers.map((provider) => (
            <button
              key={provider.key}
              type="button"
              onClick={() => void pickProvider(provider)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                provider.active ? "bg-accent" : "hover:bg-muted/50"
              )}
            >
              {provider.label}
            </button>
          ))}
        </div>

        <div className="mt-2 border-t border-border/60 px-1 pt-2 text-muted-foreground">
          Model
        </div>
        <div className="mt-1 space-y-0.5">
          {loading && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading models…</div>
          )}
          {!loading && models.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No models found</div>
          )}
          {!loading &&
            models.map((model) => (
              <button
                key={model}
                type="button"
                onClick={() => void pickModel(model)}
                className={cn(
                  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs",
                  currentModel === model ? "bg-accent" : "hover:bg-muted/50"
                )}
              >
                {model}
              </button>
            ))}
        </div>
      </div>
    </>
  );
}

/** Human verb for a permission ask: what the agent wants to do. */
function permissionVerb(toolName: string): string {
  if (toolName === "Bash" || toolName === "run_command") {
    return "run this command";
  }
  if (
    toolName === "Write" ||
    toolName === "Edit" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit" ||
    toolName === "write_file"
  ) {
    return "change this file";
  }
  return `use ${toolName}`;
}

/** The permission ask (issue #28): the agent paused on something that needs
 * a decision — the composer swaps to this panel until it is answered. */
function PermissionAskPanel({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  onAnswer: (allow: boolean, remember: "conversation" | "global" | null) => void;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">
            The agent wants to {permissionVerb(ask.toolName)}:
          </p>
          <p className="mt-1 max-h-24 overflow-y-auto break-all font-mono text-[11px] text-foreground/90">
            {ask.target}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={() => onAnswer(true, null)}
        >
          Allow
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          title="Remembers a general grant for this conversation — any command with the same programs, any file creation or edit, or the whole tool. Never shown in Settings"
          onClick={() => onAnswer(true, "conversation")}
        >
          Allow for this conversation
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          title="Remembers a general grant in every conversation — managed in Settings → Allowed"
          onClick={() => onAnswer(true, "global")}
        >
          Allow permanently
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onAnswer(false, null)}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/** The in-flight stream: streaming text reveals word by word (issue #22)
 * with a cursor on the newest piece; the goal progress lives ONLY in the
 * pinned widget above the composer — TodoWrite pieces render nothing here. */
function StreamingMessage({ stream }: { stream: StreamState }) {
  const lastTextIndex = (() => {
    for (let i = stream.segments.length - 1; i >= 0; i--) {
      if (stream.segments[i].kind === "text") return i;
    }
    return -1;
  })();
  return (
    <div className="flex w-full justify-start px-1">
      <div className="w-full max-w-[85%] min-w-0 space-y-2 has-[[data-shaim-table]]:max-w-full">
        {stream.thinking.length > 0 && (
          <p className="animate-fade-in mb-1 whitespace-pre-wrap text-xs italic text-muted-foreground">
            {stream.thinking}
          </p>
        )}
        {stream.segments.map((segment, index) =>
          segment.kind === "text" ? (
            <StreamingText
              key={index}
              text={segment.text}
              instant={index !== lastTextIndex}
            />
          ) : isReasoningTitle(segment.title) ? (
            <p
              key={index}
              className="animate-fade-in whitespace-pre-wrap text-xs italic text-muted-foreground"
            >
              {segment.detail}
            </p>
          ) : (
            <StreamingActivity key={index} segment={segment} />
          ),
        )}
      </div>
    </div>
  );
}

/** One live activity block. TodoWrite pieces feed the pinned goal-progress
 * widget instead — rendering them here would stack one block per update. */
function StreamingActivity({
  segment,
}: {
  segment: Extract<StreamSegment, { kind: "activity" }>;
}) {
  if (parseTodoWrite(segment.detail)) return null;
  return (
    <ActivityBlock
      title={segment.title}
      detail={segment.detail}
      defaultOpen={segment.open}
    />
  );
}
