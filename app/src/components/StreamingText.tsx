import { useEffect, useMemo, useState } from "react";

import { stripShaimTodoBlocks } from "@/lib/shaimBlocks";
import { cn } from "@/lib/utils";

/** How many tail tokens stay in the animated window. */
const ANIMATED_TAIL = 8;
/** Catch-up speed: tokens per tick of the reveal timer. */
const TOKENS_PER_TICK = 2;
const TICK_MS = 24;

/**
 * Streaming text (issue #22, assistant-ui style): the reply's raw stream
 * arrives in fast chunks; this component reveals it WORD BY WORD so new
 * words fade in visibly instead of chunks popping. Older words settle as
 * plain text (no re-animation), only the freshest tail animates. Goal
 * progress blocks are masked — their live state shows in the pinned widget,
 * not as raw JSON in the stream. Once the run finishes, the persisted
 * message re-renders as full markdown.
 */
export function StreamingText({
  text,
  instant = false,
  className,
}: {
  text: string;
  /** Skip the reveal animation — earlier segments that are already done. */
  instant?: boolean;
  className?: string;
}) {
  // Whitespace-capturing split: joining the tokens back is loss-free, so
  // line breaks and indentation survive the reveal. Goal-progress blocks
  // (even half-streamed ones) never reach the visible text.
  const tokens = useMemo(
    () => stripShaimTodoBlocks(text).split(/(\s+)/),
    [text],
  );
  const [revealed, setRevealed] = useState(() =>
    instant ? tokens.length : Math.min(tokens.length, TOKENS_PER_TICK),
  );

  useEffect(() => {
    if (instant) {
      setRevealed(tokens.length);
      return;
    }
    // A faster stream than the reveal just raises the target — the timer
    // catches up at a steady, readable pace.
    const timer = window.setInterval(() => {
      setRevealed((current) =>
        current >= tokens.length
          ? current
          : Math.min(tokens.length, current + TOKENS_PER_TICK),
      );
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [tokens.length, instant]);

  const shown = tokens.slice(0, revealed);
  const tailStart = Math.max(0, shown.length - ANIMATED_TAIL);
  const settled = shown.slice(0, tailStart).join("");
  const tail = shown.slice(tailStart);

  return (
    <div className={cn("animate-fade-in", className)}>
      <p className="whitespace-pre-wrap break-words">
        {settled}
        {tail.map((token, index) =>
          /^\s+$/.test(token) ? (
            token
          ) : (
            <span key={tailStart + index} className="animate-word-in">
              {token}
            </span>
          ),
        )}
      </p>
    </div>
  );
}
