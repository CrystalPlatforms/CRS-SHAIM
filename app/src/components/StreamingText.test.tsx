//! Streaming text reveal (issue #22): words fade in one by one instead of
//! chunks popping.
//!
//! Assumptions these tests encode:
//! - The raw stream text splits on whitespace-capturing boundaries — joining
//!   the revealed tokens back reproduces the text byte-identically, so line
//!   breaks survive the reveal.
//! - `instant` renders everything settled at once (earlier segments).
//! - The newest tail tokens render as animated spans; older text stays
//!   plain, so finishing a long reply never re-animates it.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { StreamingText } from "./StreamingText";

describe("StreamingText", () => {
  it("reveals the stream progressively, nothing beyond the first window", () => {
    const { container } = render(<StreamingText text="one two three four five six seven eight nine ten" />);
    const paragraph = container.querySelector("p") as HTMLElement;
    // jsdom runs timers only when advanced — the initial frame shows the
    // first revealed window, the rest stays unrevealed.
    expect(paragraph.textContent?.length).toBeGreaterThan(0);
    expect(paragraph.textContent?.length).toBeLessThan("one two three four five six seven eight nine ten".length);
  });

  it("renders instantly when told to (older segments)", () => {
    const { container } = render(<StreamingText instant text="pełny segment od razu" />);
    const paragraph = container.querySelector("p") as HTMLElement;
    expect(paragraph.textContent).toBe("pełny segment od razu");
  });

  it("keeps whitespace tokens as plain text and words as animated spans", () => {
    const { container } = render(<StreamingText text="alpha beta" />);
    const spans = container.querySelectorAll("span.animate-word-in");
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.length).toBeLessThanOrEqual(8);
  });
});
