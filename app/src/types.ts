/** Mirrors of the Rust `store::*` structs — keep both sides in sync. */

export interface Conversation {
  id: number;
  title: string;
  server_id: number | null;
  model_id: string | null;
  mode: string;
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
  reaction: string | null;
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
  | { type: "user_message"; id: number; content: string; images: string[] }
  | { type: "history"; messages: Message[] }
  | { type: "started"; generation_id: number }
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "title_changed"; title: string }
  | { type: "done"; message_id: number; content: string; thinking: string; aborted: boolean }
  | { type: "error"; message: string };
