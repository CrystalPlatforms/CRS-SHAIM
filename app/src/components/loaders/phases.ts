//! Thinking-loader phases (issue #23). Pure logic: from the live stream
//! state it derives WHAT the model is doing right now and which loader plus
//! label represents that phase. Every phase maps one-to-one onto the user's
//! own /loaders gallery — same pattern, same wording:
//!
//!   Connecting...      request on its way to a server model
//!   Thinking...        reasoning
//!   Generating...      the answer is streaming (not thinking)
//!   Reading...         FILE reads
//!   Analyzing...       image reads and everything read that is not a file
//!   Searching...       the web or the computer
//!   Fetching...        web page content
//!   Running...         a command being executed without its own loader
//!   Writing...         writing or editing a file
//!   Discombobulating... everywhere nothing else fits
//!   Idle               nothing is happening
//!
//! The gallery's Planning/Creating stay reserved — Error is a state icon
//! (see AgentLoader "error"), not a streaming phase.

import type { LoaderType } from "./AgentLoader";
import type { StreamSegment } from "@/types";

/** Structural subset of ChatPane's StreamState — keeps the import graph
 * one-way (components → this module, never back). */
export interface LoaderStream {
  thinking: string;
  segments: StreamSegment[];
}

/** What the model is doing, in one word — the key to labels and loaders. */
export type LoaderVerb =
  | "idle"
  | "connecting"
  | "thinking"
  | "generating"
  | "reading"
  | "analyzing"
  | "searching"
  | "fetching"
  | "writing"
  | "running"
  | "working";

interface VerbSpec {
  /** The phase's fixed label — verbatim wording for the app. */
  label: string;
  /** The dot-matrix loader from the /loaders gallery. */
  loader: LoaderType;
}

const VERB_SPECS: Record<LoaderVerb, VerbSpec> = {
  // idle.html — the static gray grid
  idle: { label: "Idle", loader: "idle" },
  // connecting.html — diagonal-swipe
  connecting: { label: "Connecting...", loader: "diagonal-swipe" },
  // thinking.html — sparkle
  thinking: { label: "Thinking...", loader: "sparkle" },
  // generating.html — helix
  generating: { label: "Generating...", loader: "helix" },
  // reading.html — fill-sweep
  reading: { label: "Reading...", loader: "fill-sweep" },
  // analyzing.html — checkerboard
  analyzing: { label: "Analyzing...", loader: "checkerboard" },
  // searching.html — pulse
  searching: { label: "Searching...", loader: "pulse" },
  // fetching.html — scan
  fetching: { label: "Fetching...", loader: "scan" },
  // running.html — cascade; a command being executed that carries no more
  // specific loader of its own. Pattern per the user's dist gallery.
  running: { label: "Running...", loader: "cascade" },
  // writing.html — the sequential fill; FILES only (write or edit)
  writing: { label: "Writing...", loader: "fill" },
  // discombobulating.html — orbit; the everywhere-else phase
  working: { label: "Discombobulating...", loader: "orbit" },
};

/** Where a live stream stands, decided by what arrived last: an open
 * activity block names the ongoing work, reasoning/thinking deltas mean
 * thought, plain text means the answer is streaming. */
export type LoaderPhase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "thinking" }
  | { kind: "generating" }
  | { kind: "working" }
  | { kind: "activity"; title: string };

/** Which brain the reply comes from — a server model shows Connecting...
 * while the request is in flight; a spawned CLI just reads as the default. */
export type LoaderBrain = "server" | "cli";

export function currentPhase(
  stream: LoaderStream,
  brain: LoaderBrain = "cli",
): LoaderPhase {
  const segments = stream.segments;
  const last = segments[segments.length - 1];
  // The latest activity names the present — OPEN while its input streams
  // and CLOSED while its work still executes: the adapters close the block
  // the moment a command STARTS, its result lands later as an append. Any
  // newer text or activity would take the `last` spot instead.
  if (last?.kind === "activity") {
    return { kind: "activity", title: last.title };
  }
  if (stream.thinking.trim().length > 0) {
    return { kind: "thinking" };
  }
  const lastText = last?.kind === "text" ? last.text : "";
  if (lastText.trim().length > 0) {
    return { kind: "generating" };
  }
  if (segments.length > 0 || stream.thinking.length > 0) {
    return { kind: "working" };
  }
  // Nothing arrived yet.
  return brain === "server" ? { kind: "connecting" } : { kind: "working" };
}

/** Maps an activity title onto a verb with NEUTRAL keywords — the generic
 * words any CLI prints. Order matters: specific phases first, so
 * "Delegating research" stays the default instead of turning into a
 * search, and a file read with an image extension analyzes (not reads). */
export function verbForTitle(title: string): LoaderVerb {
  const t = title.toLowerCase();
  if (t.includes("think") || t.includes("reason")) return "thinking";
  // Guard delegation before the keyword sweep — a subagent "researching"
  // is delegation, not a search.
  if (t.includes("delegat")) return "working";
  if (t.includes("search") || t.includes("grep") || t.includes("glob")) return "searching";
  if (t.includes("fetch") || t.includes("download")) return "fetching";
  const isImage = /\.(png|jpe?g|webp|gif|bmp|svg)\b/i.test(title);
  if (t.includes("read") || t.includes("open")) {
    return isImage ? "analyzing" : "reading";
  }
  if (
    t.includes("analyz") ||
    t.includes("analys") ||
    t.includes("inspect") ||
    t.includes("scan")
  ) {
    return "analyzing";
  }
  if (
    t.includes("writ") ||
    t.includes("wrote") ||
    t.includes("edit") ||
    t.includes("creat") ||
    t.includes("updat") ||
    t.includes("patch")
  ) {
    return "writing";
  }
  // A command being executed — unless it matched a more specific loader
  // above (a searching command hit "search"/"grep"/"glob" already), it
  // runs as Running...
  if (
    t.includes("$") ||
    t.includes("run") ||
    t.includes("exec") ||
    t.includes("bash") ||
    t.includes("shell") ||
    t.includes("command")
  ) {
    return "running";
  }
  return "working";
}

/** The verb of a phase — the key into the label/loader tables. */
export function phaseVerb(phase: LoaderPhase): LoaderVerb {
  switch (phase.kind) {
    case "activity":
      return verbForTitle(phase.title);
    default:
      return phase.kind;
  }
}

/** The phase's fixed label — constant while the phase lasts. */
export function labelFor(verb: LoaderVerb): string {
  return VERB_SPECS[verb].label;
}

/** The dot-matrix loader that visualizes a verb. */
export function verbLoader(verb: LoaderVerb): LoaderType {
  return VERB_SPECS[verb].loader;
}
