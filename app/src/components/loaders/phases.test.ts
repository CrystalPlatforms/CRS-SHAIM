//! Loader-phase tests (issue #23). The StreamStatus component owns the
//! animation; these pin the pure decisions both the loader type and the
//! label hang on.
//!
//! Assumptions these tests encode:
//! - Every phase maps one-to-one onto the user's /loaders gallery — same
//!   pattern, same wording ("Thinking...", "Discombobulating...", bare
//!   "Idle").
//! - Generating means the ANSWER is streaming (thinking excluded); a
//!   server model's request in flight is Connecting; nothing at all is
//!   Idle (the component decides that from a null stream).
//! - Reading is FILE reads; a read with an image extension analyzes.
//! - Writing means FILES — creating or updating them.
//! - Planning and Creating stay reserved; Error is a state icon, not a
//!   phase; Reviewing was renamed to Running.
//! - Not covered here (component level): the crossfade animation —
//!   StreamStatus.test.tsx renders that.

import { describe, expect, it } from "vitest";

import {
  currentPhase,
  labelFor,
  phaseVerb,
  verbForTitle,
  verbLoader,
  type LoaderStream,
} from "./phases";

const stream = (partial: Partial<LoaderStream>): LoaderStream => ({
  thinking: "",
  segments: [],
  ...partial,
});

describe("currentPhase", () => {
  it("reads the empty stream as Connecting for a server brain", () => {
    expect(currentPhase(stream({}), "server")).toEqual({ kind: "connecting" });
  });

  it("reads the empty stream as the default phase for a CLI brain", () => {
    expect(currentPhase(stream({}), "cli")).toEqual({ kind: "working" });
  });

  it("reads natural-mode thinking deltas as thinking", () => {
    expect(currentPhase(stream({ thinking: "Let me consider…" }))).toEqual({
      kind: "thinking",
    });
  });

  it("treats an open activity block as the present, with its title", () => {
    expect(
      currentPhase(
        stream({
          segments: [
            { kind: "text", text: "earlier answer" },
            { kind: "activity", title: "Searching the project", detail: "", open: true },
          ],
        }),
      ),
    ).toEqual({ kind: "activity", title: "Searching the project" });
  });

  it("keeps a CLOSED activity as the present while its work executes", () => {
    // The adapters close the block the moment a command starts — the
    // result lands later — so the closed block still names the present.
    const closed = stream({
      segments: [
        { kind: "activity", title: "Running $ npm test", detail: "", open: false },
      ],
    });
    expect(currentPhase(closed)).toEqual({
      kind: "activity",
      title: "Running $ npm test",
    });
    expect(phaseVerb(currentPhase(closed))).toBe("running");
  });

  it("never lets a CLOSED activity outrank newer evidence", () => {
    expect(
      currentPhase(
        stream({
          thinking: "",
          segments: [
            { kind: "activity", title: "Reading app.rs", detail: "", open: false },
            { kind: "text", text: "The answer is…" },
          ],
        }),
      ),
    ).toEqual({ kind: "generating" });
  });

  it("keeps the default phase for a closed block that names nothing specific", () => {
    expect(
      currentPhase(
        stream({
          segments: [{ kind: "activity", title: "MysteryTool", detail: "", open: false }],
        }),
      ),
    ).toEqual({ kind: "activity", title: "MysteryTool" });
    expect(phaseVerb(currentPhase(stream({
      segments: [{ kind: "activity", title: "MysteryTool", detail: "", open: false }],
    })))).toBe("working");
  });

  it("reads the streaming ANSWER as generating — in both brains", () => {
    const flowing = stream({ segments: [{ kind: "text", text: "Hello" }] });
    expect(currentPhase(flowing, "server")).toEqual({ kind: "generating" });
    expect(currentPhase(flowing, "cli")).toEqual({ kind: "generating" });
  });
});

describe("verbForTitle", () => {
  it("maps reasoning to thinking", () => {
    expect(verbForTitle("Thinking")).toBe("thinking");
    expect(verbForTitle("Reasoning")).toBe("thinking");
  });

  it("maps searching by its generic words", () => {
    expect(verbForTitle("Searching the project")).toBe("searching");
    expect(verbForTitle("Searching rust streams")).toBe("searching");
    expect(verbForTitle("Grep")).toBe("searching");
    expect(verbForTitle("Glob")).toBe("searching");
  });

  it("maps web content to fetching", () => {
    expect(verbForTitle("Fetching https://example.com")).toBe("fetching");
    expect(verbForTitle("Downloading model weights")).toBe("fetching");
  });

  it("splits reads: FILE reads read, image reads analyze", () => {
    expect(verbForTitle("Reading app.rs")).toBe("reading");
    expect(verbForTitle("Reading src/main.tsx")).toBe("reading");
    expect(verbForTitle("Reading screenshot.png")).toBe("analyzing");
    expect(verbForTitle("Reading photo.jpeg")).toBe("analyzing");
  });

  it("maps analyzing and inspecting to analyzing", () => {
    expect(verbForTitle("Analyzing the project structure")).toBe("analyzing");
    expect(verbForTitle("Inspecting sources")).toBe("analyzing");
    expect(verbForTitle("Scanning sources")).toBe("analyzing");
  });

  it("reserves Writing for FILE creation and updates", () => {
    expect(verbForTitle("Writing file.rs")).toBe("writing");
    expect(verbForTitle("Wrote file.rs")).toBe("writing");
    expect(verbForTitle("Edited main.tsx")).toBe("writing");
    expect(verbForTitle("Updated config.toml")).toBe("writing");
  });

  it("sends commands without their own loader to Running", () => {
    expect(verbForTitle("Running $ git status")).toBe("running");
    expect(verbForTitle("Ran $ cargo build")).toBe("running");
    expect(verbForTitle("Bash")).toBe("running");
    // A searching command keeps its own loader.
    expect(verbForTitle("Running $ grep TODO app.ts")).toBe("searching");
  });

  it("keeps commands, delegation and unknown tools in the default phase", () => {
    expect(verbForTitle("Delegating research to a subagent")).toBe("working");
    expect(verbForTitle("Calling a tool")).toBe("working");
    expect(verbForTitle("MysteryTool")).toBe("working");
  });
});

describe("phaseVerb", () => {
  it("passes simple phases through unchanged", () => {
    expect(phaseVerb({ kind: "idle" })).toBe("idle");
    expect(phaseVerb({ kind: "connecting" })).toBe("connecting");
    expect(phaseVerb({ kind: "thinking" })).toBe("thinking");
    expect(phaseVerb({ kind: "generating" })).toBe("generating");
    expect(phaseVerb({ kind: "working" })).toBe("working");
  });

  it("derives the verb of an activity phase from its title", () => {
    expect(phaseVerb({ kind: "activity", title: "Reading app.rs" })).toBe("reading");
    expect(phaseVerb({ kind: "activity", title: "Reading image.png" })).toBe("analyzing");
  });
});

describe("labelFor", () => {
  it("gives each phase its label from the /loaders gallery", () => {
    expect(labelFor("idle")).toBe("Idle");
    expect(labelFor("connecting")).toBe("Connecting...");
    expect(labelFor("thinking")).toBe("Thinking...");
    expect(labelFor("generating")).toBe("Generating...");
    expect(labelFor("reading")).toBe("Reading...");
    expect(labelFor("analyzing")).toBe("Analyzing...");
    expect(labelFor("searching")).toBe("Searching...");
    expect(labelFor("fetching")).toBe("Fetching...");
    expect(labelFor("running")).toBe("Running...");
    expect(labelFor("writing")).toBe("Writing...");
    expect(labelFor("working")).toBe("Discombobulating...");
  });
});

describe("verbLoader", () => {
  it("gives every verb one of the gallery's dot patterns", () => {
    const loaders = [
      "braille", "orbit", "breathe", "snake", "fill-sweep", "fill", "pulse",
      "columns", "checkerboard", "scan", "rain", "cascade", "sparkle",
      "wave-rows", "helix", "diagonal-swipe", "idle", "error",
    ] as const;
    for (const verb of [
      "idle", "connecting", "thinking", "generating", "reading",
      "analyzing", "searching", "fetching", "writing", "running", "working",
    ] as const) {
      expect(loaders).toContain(verbLoader(verb));
    }
  });

  it("keeps the gallery's pattern pairings stable", () => {
    // idle.html — the static gray grid
    expect(verbLoader("idle")).toBe("idle");
    // connecting.html — diagonal-swipe
    expect(verbLoader("connecting")).toBe("diagonal-swipe");
    // thinking.html — sparkle
    expect(verbLoader("thinking")).toBe("sparkle");
    // generating.html — helix
    expect(verbLoader("generating")).toBe("helix");
    // reading.html — fill-sweep
    expect(verbLoader("reading")).toBe("fill-sweep");
    // analyzing.html — checkerboard
    expect(verbLoader("analyzing")).toBe("checkerboard");
    // searching.html — pulse
    expect(verbLoader("searching")).toBe("pulse");
    // fetching.html — scan
    expect(verbLoader("fetching")).toBe("scan");
    // running.html — cascade (the user's fixed gallery is the truth)
    expect(verbLoader("running")).toBe("cascade");
    // writing.html — the sequential fill
    expect(verbLoader("writing")).toBe("fill");
    // discombobulating.html — orbit
    expect(verbLoader("working")).toBe("orbit");
  });
});
