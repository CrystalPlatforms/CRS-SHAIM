//! Rich-rendering component tests (Phase 6 acceptance fixture).
//!
//! Assumptions these tests encode:
//! - The fixture conversation carries every element type the phase requires:
//!   headings, lists, a table, a blockquote, a link, inline code, fenced code
//!   in three languages, a thinking block and two image attachments.
//! - Fenced code blocks each expose a "Copy code" button whose click copies
//!   the *raw* block text (highlighting must not alter the payload).
//! - Thinking blocks render collapsed by default and expand on click.
//! - Images render as <img> elements with the stored data URL untouched.
//!
//! Not covered here (integration level instead): payload assembly for vision
//! models (Rust gateway tests) and Store round-trips (Rust store tests).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { Message } from "@/types";
import { MarkdownMessage, ThinkingBlock } from "@/components/Markdown";
import { MessageView } from "@/components/MessageView";

const FIXTURE_MARKDOWN = `# Shaim Rendering Fixture

## Lists

- first bullet
- second bullet

1. step one
2. step two

## Table

| Model | Kind |
| ----- | ---- |
| llama3 | ollama |
| gpt-4o | openai |

> A blockquote with a thought worth keeping.

A link to [Shaim on the web](https://shaim.pages.dev) and some \`inline code\` too.

\`\`\`rust
fn main() {
    println!("Hello from Rust");
}
\`\`\`

\`\`\`python
def greet():
    print("Hello from Python")
\`\`\`

\`\`\`javascript
console.log("Hello from JavaScript");
\`\`\`
`;

const THINKING = "The user wants a fixture; let me assemble every element type.";
const PNG_IMAGE = "data:image/png;base64,QUJDREVG";
const JPEG_IMAGE = "data:image/jpeg;base64,MTIzNDU2";

beforeEach(() => {
  // jsdom has no clipboard; stub the write side.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

describe("MarkdownMessage", () => {
  it("renders the full fixture: headings, lists, table, blockquote, link, inline code", () => {
    render(<MarkdownMessage content={FIXTURE_MARKDOWN} />);

    expect(screen.getByRole("heading", { level: 1, name: "Shaim Rendering Fixture" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Lists" })).toBeInTheDocument();

    expect(screen.getByText("first bullet")).toBeInTheDocument();
    expect(screen.getByText("step two")).toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByText("llama3")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Kind" })).toBeInTheDocument();

    expect(screen.getByText("A blockquote with a thought worth keeping.")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Shaim on the web" });
    expect(link).toHaveAttribute("href", "https://shaim.pages.dev");

    expect(screen.getByText("inline code")).toBeInTheDocument();
  });

  it("renders fenced code in three languages, each with a copy button", () => {
    render(<MarkdownMessage content={FIXTURE_MARKDOWN} />);

    const copyButtons = screen.getAllByLabelText("Copy code");
    expect(copyButtons.length).toBe(3);

    expect(screen.getByText(/Hello from Rust/)).toBeInTheDocument();
    expect(screen.getByText(/Hello from Python/)).toBeInTheDocument();
    expect(screen.getByText(/Hello from JavaScript/)).toBeInTheDocument();
  });

  it("copy button copies the raw code block, unmodified by highlighting", async () => {
    render(<MarkdownMessage content={FIXTURE_MARKDOWN} />);

    fireEvent.click(screen.getAllByLabelText("Copy code")[0]);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'fn main() {\n    println!("Hello from Rust");\n}\n'
    );
  });
});

describe("ThinkingBlock", () => {
  it("renders collapsed by default and expands on click", () => {
    render(<ThinkingBlock thinking={THINKING} />);

    const toggle = screen.getByRole("button", { name: /Thinking/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(THINKING)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(THINKING)).toBeInTheDocument();
  });
});

describe("MessageView", () => {
  it("renders assistant messages with thinking plus rich content", () => {
    const message: Message = {
      id: 1,
      conversation_id: 10,
      role: "assistant",
      content: "## Answer\n\n- one",
      thinking: THINKING,
      images: [],
      reaction: null,
      skill_name: null,
      created_at: 0,
    };
    render(<MessageView message={message} />);

    expect(screen.getByRole("button", { name: /Thinking/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Answer" })).toBeInTheDocument();
  });

  it("renders image attachments as img elements with the stored data URL", () => {
    const message: Message = {
      id: 2,
      conversation_id: 10,
      role: "user",
      content: "what are these?",
      thinking: null,
      images: [PNG_IMAGE, JPEG_IMAGE],
      reaction: null,
      skill_name: null,
      created_at: 0,
    };
    render(<MessageView message={message} />);

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", PNG_IMAGE);
    expect(images[1]).toHaveAttribute("src", JPEG_IMAGE);
  });

  it("keeps user messages as plain text, not markdown", () => {
    const message: Message = {
      id: 3,
      conversation_id: 10,
      role: "user",
      content: "# not a heading, just text",
      thinking: null,
      images: [],
      reaction: null,
      skill_name: null,
      created_at: 0,
    };
    render(<MessageView message={message} />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("# not a heading, just text")).toBeInTheDocument();
  });
});

describe("assistant UI directives (issue #22)", () => {
  it("renders a shaim-table directive as an interactive data table", () => {
    render(
      <MarkdownMessage
        content={"Here:\n\n```shaim-table\nname,score\nAda,99\nBo,70\n```"}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by score" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("renders a shaim-todos directive as nothing in the thread — the pinned widget shows it live", () => {
    const { container } = render(
      <MarkdownMessage
        content={
          '```shaim-todos\n{"items":[{"label":"Plan","status":"done"},{"label":"Build","status":"active"}]}\n```'
        }
      />,
    );
    expect(screen.queryByText("Goal progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    const body = container.querySelector(".markdown-body");
    expect(body).not.toBeNull();
    expect(body?.children.length ?? 1).toBe(0);
  });

  it("renders a shaim-ts directive as a timestamp divider", () => {
    render(<MarkdownMessage content={"```shaim-ts\nToday\n```"} />);
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("renders an unknown shaim-* block (queue was retired) as plain code", () => {
    render(
      <MarkdownMessage
        content={"```shaim-queue\nRun the tests now\n```"}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.queryByText("Goal progress")).not.toBeInTheDocument();
  });

  it("degrades a malformed table directive back to a plain code block", () => {
    render(
      <MarkdownMessage
        content={"```shaim-table\njust some words\n```"}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
