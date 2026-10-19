/** Parsers for the assistant-triggered UI directives (issue #22): fenced
 * blocks with the `shaim-*` info strings render as rich elements instead of
 * code. One parser per block, pure functions — the renderers stay dumb. */

/** One goal-progress checklist row (shaim-todos / Claude's TodoWrite). */
export interface TodoItem {
  label: string;
  status: "pending" | "active" | "done";
}

const TODO_STATUSES: TodoItem["status"][] = ["pending", "active", "done"];

/** Parses a `shaim-todos` body: JSON `{"items":[{"label","status"}]}`.
 * `null` when the payload is not a readable checklist. */
export function parseShaimTodos(body: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(body) as {
      items?: { label?: unknown; status?: unknown }[];
    };
    if (!Array.isArray(parsed.items)) return null;
    const items: TodoItem[] = [];
    for (const row of parsed.items) {
      if (typeof row?.label !== "string" || row.label.trim().length === 0) {
        return null;
      }
      const status = TODO_STATUSES.includes(row.status as TodoItem["status"])
        ? (row.status as TodoItem["status"])
        : "pending";
      items.push({ label: row.label, status });
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

/** Recognizes Claude Code's native TodoWrite tool input — the assistant
 * triggering goal progress through its own tool (issue #22):
 * `{"todos":[{"content","status":"pending|in_progress|completed"}]}`. */
export function parseTodoWrite(detail: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(detail) as {
      todos?: { content?: unknown; status?: unknown }[];
    };
    if (!Array.isArray(parsed.todos) || parsed.todos.length === 0) return null;
    const items: TodoItem[] = [];
    for (const row of parsed.todos) {
      if (typeof row?.content !== "string" || row.content.trim().length === 0) {
        return null;
      }
      const status =
        row.status === "in_progress"
          ? "active"
          : row.status === "completed"
            ? "done"
            : "pending";
      items.push({ label: row.content, status });
    }
    return items;
  } catch {
    return null;
  }
}

/** One parsed CSV row. */
export type CsvRow = string[];

/** Minimal CSV: comma-separated, double-quoted fields may hold commas and
 * escaped (`""`) quotes. Returns rows of equal-ish width — ragged input is
 * tolerated rather than rejected. */
export function parseCsv(body: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: CsvRow = [];
  let field = "";
  let quoted = false;
  const push = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      push();
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) endRow();
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/** The goal-progress directive body: complete OR still streaming (an
 * unclosed fence at the end of the text). */
const SHAIM_TODO_BLOCK = /```shaim-todos\s*\n([\s\S]*?)(?:```|$)/g;

/** Reads every complete `{...}` object inside a (possibly partial) items
 * list — a half-streamed row simply isn't there yet. */
function parseLooseTodoRows(body: string): TodoItem[] | null {
  const items: TodoItem[] = [];
  for (const match of body.matchAll(/\{[^{}]*\}/g)) {
    try {
      const row = JSON.parse(match[0]) as { label?: unknown; status?: unknown };
      if (typeof row.label === "string" && row.label.trim().length > 0) {
        const status = TODO_STATUSES.includes(row.status as TodoItem["status"])
          ? (row.status as TodoItem["status"])
          : "pending";
        items.push({ label: row.label, status });
      }
    } catch {
      // A torn row mid-stream — skip it, the next flush completes it.
    }
  }
  return items.length > 0 ? items : null;
}

/** The assistant's latest goal-progress state from streamed text — works
 * while the block is STILL streaming (issue #22 feedback: the widget must
 * update during the task, not after it). The last block wins. */
export function extractLastShaimTodos(text: string): TodoItem[] | null {
  let last: TodoItem[] | null = null;
  for (const match of text.matchAll(SHAIM_TODO_BLOCK)) {
    const items = parseLooseTodoRows(match[1]);
    if (items) last = items;
  }
  return last;
}

/** Removes shaim-todos blocks (complete or streaming) from display text —
 * the raw JSON never belongs in the visible stream; the widget shows it. */
export function stripShaimTodoBlocks(text: string): string {
  return text.replace(SHAIM_TODO_BLOCK, "");
}

/** A markdown table already inside the reply is NOT a directive — only the
 * fenced `shaim-table` body is. This sanity check keeps empty/garbage CSV
 * from rendering as a broken table; `null` falls back to plain code. */
export function parseShaimTable(body: string): {
  header: CsvRow;
  rows: CsvRow[];
} | null {
  const rows = parseCsv(body);
  if (rows.length < 2) return null;
  const [header, ...rest] = rows;
  if (header.every((cell) => cell.trim().length === 0)) return null;
  return { header, rows: rest };
}
