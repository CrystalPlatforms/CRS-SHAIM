import { Circle, CircleCheck, CircleDotDashed } from "lucide-react";

import type { TodoItem } from "@/lib/shaimBlocks";
import { cn } from "@/lib/utils";

/** Rows the pinned widget shows before the "+N …" counts take over. */
const WIDGET_MAX_ROWS = 3;

/**
 * Goal progress (issue #22): the assistant's to-do list for long tasks.
 * Rendered from a `shaim-todos` directive or Claude's native TodoWrite tool
 * input — the assistant triggers it, Shaim only draws it.
 */
export function GoalProgress({ items }: { items: TodoItem[] }) {
  const done = items.filter((item) => item.status === "done").length;
  const total = items.length;
  const complete = done === total && total > 0;

  return (
    <div className="my-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          Goal progress
        </span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            complete ? "text-primary" : "text-muted-foreground",
          )}
        >
          {done}/{total}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li
            key={index}
            className={cn(
              "flex items-start gap-2 text-xs leading-5",
              item.status === "done" && "text-muted-foreground",
              item.status === "active" && "text-foreground",
            )}
          >
            {item.status === "done" ? (
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            ) : item.status === "active" ? (
              <CircleDotDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <span className={cn(item.status === "done" && "line-through")}>
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The pinned live widget (above the composer, below the phase loader):
 * what the assistant is doing right now. Claude Code style — at most three
 * rows, the rest summarized as "+N Pending" and "+N Completed". */
export function GoalProgressWidget({ items }: { items: TodoItem[] }) {
  const activeFirst = [
    ...items.filter((item) => item.status === "active"),
    ...items.filter((item) => item.status === "pending"),
    ...items.filter((item) => item.status === "done"),
  ];
  const shown = activeFirst.slice(0, WIDGET_MAX_ROWS);
  const restPending = activeFirst
    .slice(WIDGET_MAX_ROWS)
    .filter((item) => item.status === "pending").length;
  const restCompleted = activeFirst
    .slice(WIDGET_MAX_ROWS)
    .filter((item) => item.status === "done").length;

  return (
    <div
      role="status"
      aria-label="Assistant goal progress"
      className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <ul className="space-y-0.5">
          {shown.map((item, index) => (
            <li
              key={index}
              className={cn(
                "flex items-center gap-1.5 text-xs leading-5",
                item.status === "done" && "text-muted-foreground",
                item.status === "active" && "text-foreground",
                item.status === "pending" && "text-muted-foreground/80",
              )}
            >
              {item.status === "done" ? (
                <CircleCheck className="h-3 w-3 shrink-0 text-primary" />
              ) : item.status === "active" ? (
                <CircleDotDashed className="h-3 w-3 shrink-0 animate-pulse text-primary" />
              ) : (
                <Circle className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              )}
              <span
                className={cn(
                  "min-w-0 truncate",
                  item.status === "done" && "line-through opacity-70",
                )}
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>
        {(restPending > 0 || restCompleted > 0) && (
          <div className="mt-1 flex gap-2 text-[11px] text-muted-foreground">
            {restPending > 0 && <span>+{restPending} Pending</span>}
            {restCompleted > 0 && <span>+{restCompleted} Completed</span>}
          </div>
        )}
      </div>
    </div>
  );
}
