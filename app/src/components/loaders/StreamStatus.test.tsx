//! StreamStatus rendering tests (issue #23).
//!
//! Assumptions these tests encode:
//! - The component is a thin shell over `phases.ts`: what matters here is
//!   that the right LABEL is on screen for a given live stream and that a
//!   change of phase swaps the label (the loader swap follows the same
//!   decision, covered by phases.test.ts).
//! - A null stream means Idle — the status line is always on screen.
//! - The brain prop decides the pre-first-token phase: a server model
//!   connects, a CLI brain reads as the default.
//! - The label sits in a `status` live region so a phase change is
//!   announced without stealing focus, and shows ONE fixed name per phase.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { StreamSegment } from "@/types";
import { StreamStatus } from "./StreamStatus";

const textStream = (text: string) => {
  const segments: StreamSegment[] = [{ kind: "text", text }];
  return { thinking: "", segments };
};

describe("StreamStatus", () => {
  it("shows Idle when nothing is happening", () => {
    render(<StreamStatus stream={null} />);
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("shows Connecting while a server model's request is in flight", () => {
    render(<StreamStatus stream={{ thinking: "", segments: [] }} brain="server" />);
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("shows Generating while the answer streams", () => {
    render(<StreamStatus stream={textStream("The answer is…")} />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("says Thinking while only reasoning has arrived", () => {
    render(<StreamStatus stream={{ thinking: "Considering…", segments: [] }} />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("follows an open activity block — searching shows Searching", () => {
    const segments: StreamSegment[] = [
      { kind: "activity", title: "Searching the project", detail: "", open: true },
    ];
    render(<StreamStatus stream={{ thinking: "", segments }} />);
    expect(screen.getByText("Searching...")).toBeInTheDocument();
  });

  it("reserves Writing for file work, not for the answer", () => {
    const segments: StreamSegment[] = [
      { kind: "activity", title: "Writing file.rs", detail: "", open: true },
    ];
    render(<StreamStatus stream={{ thinking: "", segments }} />);
    expect(screen.getByText("Writing...")).toBeInTheDocument();
  });

  it("reads images as Analyzing, files as Reading", () => {
    const image: StreamSegment[] = [
      { kind: "activity", title: "Reading screenshot.png", detail: "", open: true },
    ];
    render(<StreamStatus stream={{ thinking: "", segments: image }} />);
    expect(screen.getByText("Analyzing...")).toBeInTheDocument();
  });

  it("swaps the label when the phase changes mid-stream", () => {
    const segments: StreamSegment[] = [
      { kind: "activity", title: "Reading app.rs", detail: "", open: true },
    ];
    const { rerender } = render(
      <StreamStatus stream={{ thinking: "", segments }} />,
    );
    expect(screen.getByText("Reading...")).toBeInTheDocument();

    const next: StreamSegment[] = [
      { kind: "activity", title: "Reading app.rs", detail: "", open: false },
      { kind: "text", text: "Done reading —" },
    ];
    rerender(<StreamStatus stream={{ thinking: "", segments: next }} />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
    expect(screen.queryByText("Reading...")).not.toBeInTheDocument();
  });

  it("announces phases politely", () => {
    render(<StreamStatus stream={textStream("Hi")} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
