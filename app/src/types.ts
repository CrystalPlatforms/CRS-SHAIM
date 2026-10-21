/** Mirrors of the Rust `store::*` structs — keep both sides in sync. */

export type AgentKind = "claude_code" | "codex";

export interface Conversation {
  id: number;
  title: string;
  server_id: number | null;
  model_id: string | null;
  mode: string;
  agent_kind: AgentKind | null;
  project_path: string | null;
  system_prompt: string | null;
  temperature: number | null;
  context_len: number | null;
  thinking: boolean;
  created_at: number;
  updated_at: number;
}

export type ServerKind = "ollama" | "openai_compatible";

export interface Server {
  id: number;
  name: string;
  kind: ServerKind;
  base_url: string;
  api_key: string | null;
}

export interface ModelInfo {
  id: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking: string | null;
  images: string[];
  /** Skill invoked with `/` on this message — display metadata only. */
  skill_name: string | null;
  created_at: number;
}

export interface AppSettings {
  default_server_id: number | null;
  default_model_id: string | null;
  default_system_prompt: string | null;
}

/** One full-text search hit, with the context needed to jump to the message. */
export interface SearchHit {
  message_id: number;
  conversation_id: number;
  conversation_title: string;
  role: string;
  snippet: string;
  created_at: number;
}

/** Events streamed from the chat commands over a Tauri channel. */
export type ChatStreamEvent =
  | {
      type: "user_message";
      id: number;
      content: string;
      images: string[];
      skill_name: string | null;
    }
  | { type: "history"; messages: Message[] }
  | { type: "started"; generation_id: number }
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "activity_start"; title: string }
  | { type: "activity_append"; detail: string }
  | { type: "activity_retitle"; title: string }
  | { type: "activity_end" }
  /** The agent asks to run something (issue #28) — the composer swaps to
   * the allow buttons until `respond_permission` answers. */
  | {
      type: "permission_request";
      request_id: string;
      tool_name: string;
      target: string;
    }
  | { type: "title_changed"; title: string }
  | { type: "done"; message_id: number; content: string; thinking: string; aborted: boolean }
  /** Agent runs end with a full history push plus this marker. */
  | { type: "agent_done"; aborted: boolean; error: string | null }
  | { type: "error"; message: string };

/** One ordered piece of a streaming agent run — text becomes an assistant
 * message, activity a collapsible block. Mirrors `agent::Segment`. */
export type StreamSegment =
  | { kind: "text"; text: string }
  | { kind: "activity"; title: string; detail: string; open: boolean };

/** JSON payload of a `tool`-role message: one collapsible activity block. */
export interface ActivityPayload {
  title: string;
  detail: string;
}

/** Unpacks a tool-role message; malformed payloads degrade to raw text. */
export function parseActivity(content: string): ActivityPayload {
  try {
    const parsed = JSON.parse(content) as Partial<ActivityPayload>;
    if (typeof parsed.title === "string" && typeof parsed.detail === "string") {
      return { title: parsed.title, detail: parsed.detail };
    }
  } catch {
    // fall through to the raw-text fallback
  }
  return { title: "Activity", detail: content };
}

/** Agent reasoning (Claude "Thinking", Codex "Reasoning") is never a framed
 * block — it renders as plain italic text, like natural-mode thinking. */
export function isReasoningTitle(title: string): boolean {
  return title === "Thinking" || title === "Reasoning";
}

/** Slash commands built into each CLI, offered in the composer — passed
 * through to the agent verbatim. The installed skills join them in the
 * palette (see `SkillInfo`). */
export const AGENT_COMMANDS: Record<AgentKind, { cmd: string; hint: string }[]> = {
  claude_code: [
    { cmd: "/init", hint: "Analyze the project and write CLAUDE.md" },
    { cmd: "/review", hint: "Review code or a pull request" },
    { cmd: "/pr-comments", hint: "Fetch GitHub PR comments" },
    { cmd: "/release-notes", hint: "Show release notes" },
    { cmd: "/compact", hint: "Compact the session, keep a summary" },
    { cmd: "/clear", hint: "Start a fresh session" },
    { cmd: "/cost", hint: "Show token usage and cost" },
    { cmd: "/status", hint: "Show session status" },
    { cmd: "/model", hint: "Show or pick the model" },
    { cmd: "/memory", hint: "Edit CLAUDE.md memory files" },
    { cmd: "/agents", hint: "Manage subagents" },
    { cmd: "/mcp", hint: "Manage MCP servers" },
    { cmd: "/permissions", hint: "Show tool permissions" },
    { cmd: "/add-dir", hint: "Add another working directory" },
    { cmd: "/resume", hint: "Resume a past session" },
    { cmd: "/help", hint: "List everything the CLI can do" },
  ],
  codex: [
    { cmd: "/init", hint: "Generate an AGENTS.md for the project" },
    { cmd: "/diff", hint: "Show the session's changes" },
    { cmd: "/review", hint: "Review the current changes" },
    { cmd: "/plan", hint: "Plan before touching anything" },
    { cmd: "/mention", hint: "Mention a file or folder" },
    { cmd: "/compact", hint: "Compact the session, keep a summary" },
    { cmd: "/clear", hint: "Start a fresh session" },
    { cmd: "/new", hint: "Start a new thread" },
    { cmd: "/status", hint: "Show session status" },
    { cmd: "/model", hint: "Show or pick the model" },
    { cmd: "/approvals", hint: "Show approval settings" },
    { cmd: "/resume", hint: "Resume a past session" },
    { cmd: "/fork", hint: "Fork the current session" },
  ],
};

/** One skill (or custom command) installed for an agent CLI. */
export interface SkillInfo {
  name: string;
  description: string;
}

/** One standing permission rule (issue #28). `conversation_id` is null for
 * the global "Allow permanently" rules shown in Settings → Allowed; a
 * conversation-scoped rule never appears there. */
export interface AllowedRule {
  id: number;
  conversation_id: number | null;
  kind: "command" | "file" | "tool";
  pattern: string;
  created_at: number;
}

/** One skill in Shaim's own library, as shown in Settings → Skills. Enabled
 * skills ride in request assembly; any skill can be invoked one-shot from
 * the composer's "/" palette. */
export interface StoredSkill {
  id: number;
  name: string;
  description: string;
  kind: "package" | "markdown";
  enabled: boolean;
  path: string;
  size_bytes: number;
  created_at: number;
}
