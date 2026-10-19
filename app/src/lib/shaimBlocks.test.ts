import { describe, expect, it } from "vitest";

import {
  extractLastShaimTodos,
  parseCsv,
  parseShaimTable,
  parseShaimTodos,
  parseTodoWrite,
  stripShaimTodoBlocks,
} from "./shaimBlocks";

describe("parseShaimTodos", () => {
  it("reads a valid checklist", () => {
    const items = parseShaimTodos(
      `{"items":[{"label":"Set up the repo","status":"done"},{"label":"Write tests","status":"active"},{"label":"Ship","status":"pending"}]}`,
    );
    expect(items).toEqual([
      { label: "Set up the repo", status: "done" },
      { label: "Write tests", status: "active" },
      { label: "Ship", status: "pending" },
    ]);
  });

  it("defaults unknown statuses to pending", () => {
    const items = parseShaimTodos(`{"items":[{"label":"One","status":"weird"}]}`);
    expect(items).toEqual([{ label: "One", status: "pending" }]);
  });

  it("rejects malformed payloads so the block degrades to code", () => {
    expect(parseShaimTodos("not json")).toBeNull();
    expect(parseShaimTodos(`{"items":"nope"}`)).toBeNull();
    expect(parseShaimTodos(`{"items":[{"label":""}]}`)).toBeNull();
    expect(parseShaimTodos(`{"items":[]}`)).toBeNull();
  });
});

describe("parseTodoWrite", () => {
  it("maps Claude's native tool input onto the checklist", () => {
    const items = parseTodoWrite(
      `{"todos":[{"content":"Plan","status":"completed"},{"content":"Build","status":"in_progress"},{"content":"Test","status":"pending"}]}`,
    );
    expect(items).toEqual([
      { label: "Plan", status: "done" },
      { label: "Build", status: "active" },
      { label: "Test", status: "pending" },
    ]);
  });

  it("rejects everything that is not a TodoWrite payload", () => {
    expect(parseTodoWrite(`{"command":"ls"}`)).toBeNull();
    expect(parseTodoWrite(`{"todos":[]}`)).toBeNull();
    expect(parseTodoWrite("→ some tool output")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("splits rows and fields", () => {
    expect(parseCsv("name,age\nAda,36\nAlan,41")).toEqual([
      ["name", "age"],
      ["Ada", "36"],
      ["Alan", "41"],
    ]);
  });

  it("keeps commas and escaped quotes inside quoted fields", () => {
    expect(parseCsv(`name,note\n"Smith, Ada","she said ""hi"""`)).toEqual([
      ["name", "note"],
      ["Smith, Ada", 'she said "hi"'],
    ]);
  });

  it("tolerates trailing newlines and drops blank rows", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("extractLastShaimTodos", () => {
  it("returns the newest complete todos block", () => {
    const text = [
      "Starting.",
      "```shaim-todos",
      `{"items":[{"label":"A","status":"done"},{"label":"B","status":"active"},{"label":"C","status":"pending"},{"label":"D","status":"pending"}]}`,
      "```",
      "Progress update:",
      "```shaim-todos",
      `{"items":[{"label":"A","status":"done"},{"label":"B","status":"done"},{"label":"C","status":"active"},{"label":"D","status":"pending"}]}`,
      "```",
    ].join("\n");
    expect(extractLastShaimTodos(text)).toEqual([
      { label: "A", status: "done" },
      { label: "B", status: "done" },
      { label: "C", status: "active" },
      { label: "D", status: "pending" },
    ]);
  });

  it("reads complete rows from an unclosed block, skipping the torn row", () => {
    const text = [
      "```shaim-table",
      "a,b",
      "1,2",
      "```",
      "```shaim-todos",
      `{"items":[{"label":"One","status":"pending"},{"label":"Tw`,
    ].join("\n");
    expect(extractLastShaimTodos(text)).toEqual([
      { label: "One", status: "pending" },
    ]);
  });

  it("returns null when no shaim-todos block exists", () => {
    expect(extractLastShaimTodos("plain text ```rust\ncode\n```")).toBeNull();
  });

  it("reads a STILL-STREAMING unclosed block so the widget updates mid-task", () => {
    const text = [
      "Plan looks like this:",
      "```shaim-todos",
      `{"items":[{"label":"Step one","status":"done"},{"label":"Step two","status":"active"},{"label":"Thr`,
      // fence never closed — the model is mid-JSON
    ].join("\n");
    expect(extractLastShaimTodos(text)).toEqual([
      { label: "Step one", status: "done" },
      { label: "Step two", status: "active" },
    ]);
  });

  it("prefers the newest block even when an older one is closed", () => {
    const text = [
      "```shaim-todos",
      `{"items":[{"label":"Old","status":"pending"}]}`,
      "```",
      "Progress:",
      "```shaim-todos",
      `{"items":[{"label":"Old","status":"done"}]}`,
    ].join("\n");
    expect(extractLastShaimTodos(text)).toEqual([
      { label: "Old", status: "done" },
    ]);
  });
});

describe("stripShaimTodoBlocks", () => {
  it("removes complete and streaming todos blocks from display text", () => {
    const text = [
      "before",
      "```shaim-todos",
      `{"items":[{"label":"A","status":"done"}]}`,
      "```",
      "middle",
      "```shaim-todos",
      `{"items":[{"label":"B"`,
    ].join("\n");
    expect(stripShaimTodoBlocks(text)).toBe("before\n\nmiddle\n");
  });

  it("leaves ordinary fenced code untouched", () => {
    const text = "```rust\nfn main() {}\n```";
    expect(stripShaimTodoBlocks(text)).toBe(text);
  });
});

describe("parseShaimTable", () => {
  it("splits the header row from the data rows", () => {
    const table = parseShaimTable("name,score\nAda,99\nBo,70");
    expect(table).toEqual({
      header: ["name", "score"],
      rows: [
        ["Ada", "99"],
        ["Bo", "70"],
      ],
    });
  });

  it("needs at least a header and one data row", () => {
    expect(parseShaimTable("a,b")).toBeNull();
    expect(parseShaimTable("")).toBeNull();
    expect(parseShaimTable(",\n1,2")).toBeNull();
  });
});
