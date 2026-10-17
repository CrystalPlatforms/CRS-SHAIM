import { Copy, Pencil, RefreshCw, Reply, Scissors, SmilePlus, Trash2, X } from "lucide-react";

import type { Message } from "@/types";
import { isReasoningTitle, parseActivity } from "@/types";
import { MarkdownMessage, ThinkingBlock } from "@/components/Markdown";
import { ActivityBlock } from "@/components/ActivityBlock";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** Personal reactions offered in the context menu (single-user app). */
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🤯"] as const;

interface MessageViewProps {
  message: Message;
  /** Flash highlight after a search jump. */
  highlighted?: boolean;
  /** Regenerate affordance — the last assistant message only. */
  showRegenerate?: boolean;
  onRegenerate?: () => void;
  /** Edit affordance — the user's own messages. */
  onEdit?: () => void;
  /** Toggles a reaction; `null` clears it. */
  onReact?: (emoji: string | null) => void;
  onReply?: () => void;
  onDelete?: () => void;
  onFork?: () => void;
}

/**
 * One message in the thread: user messages keep a green bubble, assistant
 * messages render bare — rich markdown with a collapsible thinking block,
 * matching the chrome-less streaming view. Hover reveals the control
 * affordances (edit / regenerate); right-click opens the full action menu.
 */
export function MessageView({
  message,
  highlighted = false,
  showRegenerate = false,
  onRegenerate,
  onEdit,
  onReact,
  onReply,
  onDelete,
  onFork,
}: MessageViewProps) {
  const controls =
    !showRegenerate && !onEdit ? null : (
      <div className="group-hover/message:opacity-100 flex gap-1 opacity-0 transition-opacity">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit message"
            title="Edit message"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {showRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            aria-label="Regenerate reply"
            title="Regenerate reply"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );

  const reactionChip = message.reaction ? (
    <button
      type="button"
      onClick={() => onReact?.(null)}
      aria-label={`Remove reaction ${message.reaction}`}
      title="Remove reaction"
      className="mt-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-xs hover:border-destructive/50"
    >
      {message.reaction}
    </button>
  ) : null;

  const body =
    message.role === "user" ? (
      <div
        data-message-id={message.id}
        className={cn(
          "group/message flex w-full flex-col items-end rounded-lg",
          highlighted && "animate-highlight-pulse"
        )}
      >
        <div className="flex max-w-[85%] items-end gap-1">
          {controls}
          <div className="rounded-xl bg-primary px-3.5 py-2 text-primary-foreground">
            {message.skill_name && (
              <p className="mb-1 flex justify-end">
                <span
                  title="Skill invoked with this message"
                  className="inline-flex items-center rounded-[4px] border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 font-mono text-[11px] text-primary-foreground/80"
                >
                  /{message.skill_name}
                </span>
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm">{message.content}</p>
            {message.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.images.map((image, index) => (
                  <img
                    key={index}
                    src={image}
                    alt={`Attachment ${index + 1}`}
                    className="max-h-40 max-w-[16rem] rounded-lg border border-border object-cover"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        {reactionChip}
      </div>
    ) : message.role === "tool" ? (
      // Agent output between messages: reasoning renders as plain italic
      // text (no frame), real tool calls as collapsible activity blocks.
      (() => {
        const activity = parseActivity(message.content);
        return (
          <div
            data-message-id={message.id}
            className={cn(
              "group/message flex w-full justify-start rounded-lg px-1",
              highlighted && "animate-highlight-pulse"
            )}
          >
            <div className="w-full max-w-[85%] min-w-0">
              {isReasoningTitle(activity.title) ? (
                <p className="whitespace-pre-wrap text-xs italic text-muted-foreground">
                  {activity.detail}
                </p>
              ) : (
                <ActivityBlock {...activity} />
              )}
              {controls && <div className="mt-1">{controls}</div>}
            </div>
          </div>
        );
      })()
    ) : (
      <div
        data-message-id={message.id}
        className={cn(
          "group/message flex w-full justify-start rounded-lg px-1",
          highlighted && "animate-highlight-pulse"
        )}
      >
        <div className="max-w-[85%] min-w-0">
          {message.thinking && <ThinkingBlock thinking={message.thinking} />}
          <MarkdownMessage content={message.content} />
          {message.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.images.map((image, index) => (
                <img
                  key={index}
                  src={image}
                  alt={`Attachment ${index + 1}`}
                  className="max-h-40 max-w-[16rem] rounded-lg border border-border object-cover"
                />
              ))}
            </div>
          )}
          {controls && <div className="mt-1">{controls}</div>}
          {reactionChip}
        </div>
      </div>
    );

  // Activity blocks copy their readable detail; other messages copy verbatim.
  const copyText =
    message.role === "tool" ? parseActivity(message.content).detail : message.content;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent>
        {onEdit && (
          <ContextMenuItem onSelect={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </ContextMenuItem>
        )}
        {onReply && (
          <ContextMenuItem onSelect={onReply}>
            <Reply className="mr-2 h-4 w-4" />
            Reply
          </ContextMenuItem>
        )}
        {onReact && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <SmilePlus className="mr-2 h-4 w-4" />
              React
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {REACTION_EMOJIS.map((emoji) => (
                <ContextMenuItem
                  key={emoji}
                  onSelect={() =>
                    onReact(message.reaction === emoji ? null : emoji)
                  }
                >
                  <span className="mr-2">{emoji}</span>
                  {message.reaction === emoji ? "Remove" : null}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {onFork && (
          <ContextMenuItem onSelect={onFork}>
            <Scissors className="mr-2 h-4 w-4" />
            Fork from this
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => void navigator.clipboard.writeText(copyText)}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy
        </ContextMenuItem>
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={onDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Attachment previews shown inside the composer before sending. */
export function PendingImages({
  images,
  onRemove,
}: {
  images: string[];
  onRemove: (index: number) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {images.map((image, index) => (
        <div key={index} className="relative">
          <img
            src={image}
            alt={`Attachment ${index + 1}`}
            className="h-14 w-14 rounded-md border border-border object-cover"
          />
          <button
            type="button"
            aria-label={`Remove attachment ${index + 1}`}
            onClick={() => onRemove(index)}
            className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
