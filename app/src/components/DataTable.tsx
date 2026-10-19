import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import type { CsvRow } from "@/lib/shaimBlocks";
import { cn } from "@/lib/utils";

/**
 * Data table (issue #22): the assistant's `shaim-table` directive rendered
 * as an interactive table — click a header to sort, the sticky header keeps
 * the columns readable on long lists.
 */
export function DataTable({ header, rows }: { header: CsvRow; rows: CsvRow[] }) {
  const [sort, setSort] = useState<{ column: number; dir: 1 | -1 } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = sort.column;
    const numeric = rows.every((row) => isNumeric(row[column]));
    return [...rows].sort((a, b) => {
      const left = a[column] ?? "";
      const right = b[column] ?? "";
      const compared = numeric
        ? (Number(left) || 0) - (Number(right) || 0)
        : left.localeCompare(right);
      return compared * sort.dir;
    });
  }, [rows, sort]);

  const toggle = (column: number) => {
    setSort((current) =>
      current?.column === column
        ? current.dir === 1
          ? { column, dir: -1 }
          : null
        : { column, dir: 1 },
    );
  };

  return (
    <div
      data-shaim-table
      className="my-2 overflow-x-auto rounded-lg border border-border bg-card"
    >
      <div className="max-h-80 overflow-y-auto">
        <table className="w-max min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {header.map((cell, index) => {
                const active = sort?.column === index;
                return (
                  <th key={index} className="border-b border-border px-2.5 py-1.5 text-left">
                    <button
                      type="button"
                      onClick={() => toggle(index)}
                      aria-label={`Sort by ${cell}`}
                      className={cn(
                        "flex items-center gap-1 font-medium hover:text-foreground",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="whitespace-nowrap">{cell}</span>
                      {active ? (
                        sort?.dir === 1 ? (
                          <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUp className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => (
              <tr key={index} className="odd:bg-background even:bg-muted/30">
                {header.map((_, index2) => (
                  <td
                    key={index2}
                    className="border-b border-border/50 px-2.5 py-1.5 align-top"
                  >
                    {row[index2] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground">
        {rows.length} rows · click a header to sort
      </div>
    </div>
  );
}

function isNumeric(cell: string | undefined): boolean {
  if (cell === undefined || cell.trim() === "") return false;
  return Number.isFinite(Number(cell));
}
