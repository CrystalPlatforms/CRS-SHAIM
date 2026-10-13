import { X } from "lucide-react";

import type { Message } from "@/types";
import { MarkdownMessage, ThinkingBlock } from "@/components/Markdown";

/**
 * One message in the thread: user messages keep a green bubble, assistant
 * messages render bare — rich markdown with a collapsible thinking block,
 * matching the chrome-less streaming view.
 */
export function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] rounded-xl bg-primary px-3.5 py-2 text-primary-foreground">
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
    );
  }

  return (
    <div className="flex w-full justify-start px-1">
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
      </div>
    </div>
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
