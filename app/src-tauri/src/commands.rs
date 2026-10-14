//! Tauri command layer — thin adapters between the UI and the Store/Gateway.
//!
//! No business logic here: each command maps one UI intent to one Store call
//! (or one Gateway call). The send pipeline is the exception — it orchestrates
//! persistence, auto-titling and streaming, which is why it lives here rather
//! than in either module.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::gateway::{AbortFlag, ChatEvent, ChatOptions, ChatTurn, Endpoint, ModelInfo};
use crate::store::{Conversation, Message, Server, Settings, Store};
use crate::AppState;

type CmdResult<T> = Result<T, String>;

fn with_store<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Store) -> crate::store::Result<T>,
) -> CmdResult<T> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    f(&guard).map_err(|e| e.to_string())
}

// ---- Servers ---------------------------------------------------------------

fn endpoint_of(server: &Server) -> Endpoint {
    Endpoint {
        kind: crate::store::ServerKind::parse(&server.kind).unwrap_or(crate::store::ServerKind::Ollama),
        base_url: server.base_url.clone(),
        api_key: server.api_key.clone(),
    }
}

#[tauri::command]
pub fn add_server(
    state: State<'_, AppState>,
    name: String,
    kind: String,
    base_url: String,
    api_key: Option<String>,
) -> CmdResult<Server> {
    with_store(&state, |store| {
        store.create_server(&name, &kind, &base_url, api_key.as_deref())
    })
}

#[tauri::command]
pub fn list_servers(state: State<'_, AppState>) -> CmdResult<Vec<Server>> {
    with_store(&state, |store| store.list_servers())
}

#[tauri::command]
pub fn update_server(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    kind: String,
    base_url: String,
    api_key: Option<String>,
) -> CmdResult<()> {
    with_store(&state, |store| {
        store.update_server(id, &name, &kind, &base_url, api_key.as_deref())
    })
}

/// Deleting a server never touches past conversations (schema: ON DELETE SET
/// NULL), so this is a plain delete — nothing to clean up here.
#[tauri::command]
pub fn delete_server(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_server(id))
}

/// Reachability check + model list in one probe; used by the Settings
/// "Test connection" button and the model picker alike.
#[tauri::command]
pub async fn list_server_models(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<ModelInfo>> {
    let endpoint = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let server = guard.get_server(id).map_err(|e| e.to_string())?;
        endpoint_of(&server)
    };
    state
        .gateway
        .list_models(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

// ---- Conversations & messages ----------------------------------------------

#[tauri::command]
pub fn create_conversation(state: State<'_, AppState>, title: Option<String>) -> CmdResult<Conversation> {
    with_store(&state, |store| store.create_conversation(title.as_deref()))
}

#[tauri::command]
pub fn list_conversations(state: State<'_, AppState>) -> CmdResult<Vec<Conversation>> {
    with_store(&state, |store| store.list_conversations())
}

#[tauri::command]
pub fn get_conversation(state: State<'_, AppState>, id: i64) -> CmdResult<Conversation> {
    with_store(&state, |store| store.get_conversation(id))
}

#[tauri::command]
pub fn rename_conversation(state: State<'_, AppState>, id: i64, title: String) -> CmdResult<()> {
    with_store(&state, |store| store.rename_conversation(id, &title))
}

#[tauri::command]
pub fn delete_conversation(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_conversation(id))
}

#[tauri::command]
pub fn set_conversation_model(
    state: State<'_, AppState>,
    id: i64,
    server_id: Option<i64>,
    model_id: Option<String>,
) -> CmdResult<()> {
    with_store(&state, |store| {
        store.set_conversation_model(id, server_id, model_id.as_deref())
    })
}

#[tauri::command]
pub fn list_messages(state: State<'_, AppState>, conversation_id: i64) -> CmdResult<Vec<Message>> {
    with_store(&state, |store| store.list_messages(conversation_id))
}

// ---- Settings ----------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    with_store(&state, |store| store.get_settings())
}

#[tauri::command]
pub fn set_default_model(
    state: State<'_, AppState>,
    server_id: Option<i64>,
    model_id: Option<String>,
) -> CmdResult<()> {
    with_store(&state, |store| {
        store.set_default_model(server_id, model_id.as_deref())
    })
}

/// Sets (or clears) the app-wide default system prompt. An empty string
/// means "no default prompt".
#[tauri::command]
pub fn set_default_system_prompt(
    state: State<'_, AppState>,
    prompt: Option<String>,
) -> CmdResult<()> {
    with_store(&state, |store| {
        let prompt = prompt.as_deref().map(str::trim).filter(|s| !s.is_empty());
        store.set_default_system_prompt(prompt)
    })
}

// ---- Streamed chat -----------------------------------------------------------

/// Events pushed to the UI while a generation is running. The tag lands in
/// the `type` field of the JSON payload.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    UserMessage { id: i64, content: String, images: Vec<String> },
    /// Canonical history after a store-side rewrite (edit truncation,
    /// regenerate removal) — the UI mirrors it wholesale.
    History { messages: Vec<Message> },
    /// Sent as soon as the generation is registered. Carries the id the UI
    /// needs for `stop_generation` — the command itself only returns after
    /// the whole stream, so without this event Stop could never fire
    /// mid-stream.
    Started { generation_id: u64 },
    Thinking { text: String },
    Content { text: String },
    TitleChanged { title: String },
    Done { message_id: i64, content: String, thinking: String, aborted: bool },
    Error { message: String },
}

/// Resolves which server/model a conversation should use: the conversation's
/// own pin, falling back to the Settings defaults. Public so integration
/// tests can drive the exact mapping the send pipeline uses.
pub fn resolve_target(
    store: &Store,
    conversation_id: i64,
) -> crate::store::Result<(Endpoint, String, ChatOptions)> {
    let conversation = store.get_conversation(conversation_id)?;
    let settings = store.get_settings()?;

    let server = match conversation.server_id.or(settings.default_server_id) {
        Some(server_id) => store.get_server(server_id)?,
        None => {
            return Err(crate::store::StoreError::Sqlite(
                rusqlite::Error::InvalidParameterName(
                    "no server selected — add one in Settings → Servers".into(),
                ),
            ))
        }
    };
    let model = match conversation
        .model_id
        .clone()
        .or(settings.default_model_id.clone())
    {
        Some(model) => model,
        None => {
            return Err(crate::store::StoreError::Sqlite(
                rusqlite::Error::InvalidParameterName(
                    "no model selected — pick one in the Details panel".into(),
                ),
            ))
        }
    };

    let options = ChatOptions {
        // The conversation's own prompt; "Use default" (None) falls back to
        // the app-wide default system prompt from Settings.
        system_prompt: conversation
            .system_prompt
            .clone()
            .or_else(|| settings.default_system_prompt.clone()),
        temperature: conversation.temperature,
        context_len: conversation.context_len,
        thinking: conversation.thinking,
    };
    Ok((endpoint_of(&server), model, options))
}

/// Sends a user message and streams the assistant reply over `channel`.
///
/// Order of operations: persist the user message first (auto-titling from it
/// if this is the first one), then stream, then persist the assistant message
/// once — including the partial content of an aborted or failed stream, so
/// state stays consistent whatever happens.
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    conversation_id: i64,
    content: String,
    images: Vec<String>,
    channel: Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    // 1. Persist the user message first (auto-titling from it if this is the
    //    first one); the target itself is resolved by `stream_reply` from the
    //    persisted state (store lock held only here — never across the await).
    let (user_message, title_changed) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let user_message = guard
            .insert_message_full(conversation_id, "user", &content, None, &images)
            .map_err(|e| e.to_string())?;
        let title_changed = guard
            .maybe_autotitle(conversation_id, &content)
            .map_err(|e| e.to_string())?;
        guard.touch_conversation(conversation_id).map_err(|e| e.to_string())?;
        (user_message, title_changed)
    };

    let _ = channel.send(ChatStreamEvent::UserMessage {
        id: user_message.id,
        content: user_message.content.clone(),
        images: user_message.images.clone(),
    });
    if title_changed {
        let title = {
            let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
            guard.get_conversation(conversation_id).map_err(|e| e.to_string())?.title
        };
        let _ = channel.send(ChatStreamEvent::TitleChanged { title });
    }

    stream_reply(&state, conversation_id, &channel).await
}

/// Streams an assistant reply for the conversation's history as stored and
/// persists it. Shared by send / regenerate / edit — all three converge on
/// "history as stored → one streamed assistant message appended", so control
/// actions reuse the exact same send/stream path.
async fn stream_reply(
    state: &State<'_, AppState>,
    conversation_id: i64,
    channel: &Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    // 1. Resolve the target from the (already persisted) state.
    let (endpoint, model, options) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        resolve_target(&guard, conversation_id).map_err(|e| e.to_string())?
    };

    // 2. Build the request context from full history.
    let turns: Vec<ChatTurn> = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        guard
            .list_messages(conversation_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|m| m.role != "tool")
            .map(|m| ChatTurn {
                role: m.role,
                content: m.content,
                images: m.images,
            })
            .collect()
    };

    // 3. Register the abort handle and stream.
    let generation_id = state.next_generation.fetch_add(1, Ordering::SeqCst);
    let abort = AbortFlag::new();
    state
        .generations
        .lock()
        .map_err(|_| "generation lock poisoned")?
        .insert(generation_id, abort.clone());
    // Tell the UI the id immediately — Stop must work mid-stream.
    let _ = channel.send(ChatStreamEvent::Started { generation_id });

    let outcome = state
        .gateway
        .chat(
            &endpoint,
            &model,
            &turns,
            &options,
            &abort,
            |event| {
                let _ = channel.send(match event {
                    ChatEvent::Thinking { text } => ChatStreamEvent::Thinking { text },
                    ChatEvent::Content { text } => ChatStreamEvent::Content { text },
                });
            },
        )
        .await;

    state
        .generations
        .lock()
        .map_err(|_| "generation lock poisoned")?
        .remove(&generation_id);

    // 4. Persist the assistant message — full or partial, abort or error —
    //    so the thread never loses what the user already saw.
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = channel.send(ChatStreamEvent::Error {
                message: error.to_string(),
            });
            return Err(error.to_string());
        }
    };

    let message = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let thinking = if outcome.thinking.is_empty() {
            None
        } else {
            Some(outcome.thinking.as_str())
        };
        guard
            .insert_message_full(
                conversation_id,
                "assistant",
                &outcome.content,
                thinking,
                &[],
            )
            .map_err(|e| e.to_string())?
    };

    let _ = channel.send(ChatStreamEvent::Done {
        message_id: message.id,
        content: message.content.clone(),
        thinking: outcome.thinking.clone(),
        aborted: outcome.aborted,
    });
    Ok(generation_id)
}

/// Regenerates the reply. When the history ends with an assistant message it
/// is removed first — replaced, never appended to — and a fresh one is
/// streamed for the same history. When it ends with a user message (a send
/// that failed before any reply arrived) nothing is removed and the reply is
/// simply attempted again — which is also what the UI's Retry button does.
#[tauri::command]
pub async fn regenerate(
    state: State<'_, AppState>,
    conversation_id: i64,
    channel: Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        if let Some(last) = guard.last_message(conversation_id).map_err(|e| e.to_string())? {
            if last.role == "assistant" {
                guard.delete_message(last.id).map_err(|e| e.to_string())?;
                let messages = guard.list_messages(conversation_id).map_err(|e| e.to_string())?;
                let _ = channel.send(ChatStreamEvent::History { messages });
            }
        }
        guard.touch_conversation(conversation_id).map_err(|e| e.to_string())?;
    }
    stream_reply(&state, conversation_id, &channel).await
}

/// Edits one of the user's own messages: rewrites its content, drops every
/// later message in the path, and streams a fresh reply from that point.
/// The original message's image attachments are kept.
#[tauri::command]
pub async fn edit_message(
    state: State<'_, AppState>,
    conversation_id: i64,
    message_id: i64,
    content: String,
    channel: Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("edited message must not be empty".into());
    }
    {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let message = guard.get_message(message_id).map_err(|e| e.to_string())?;
        if message.conversation_id != conversation_id {
            return Err("message does not belong to this conversation".into());
        }
        if message.role != "user" {
            return Err("only your own messages can be edited".into());
        }
        guard
            .update_message_content(message_id, &content)
            .map_err(|e| e.to_string())?;
        guard
            .truncate_after(conversation_id, message_id)
            .map_err(|e| e.to_string())?;
        guard.touch_conversation(conversation_id).map_err(|e| e.to_string())?;
        let messages = guard.list_messages(conversation_id).map_err(|e| e.to_string())?;
        let _ = channel.send(ChatStreamEvent::History { messages });
    }
    stream_reply(&state, conversation_id, &channel).await
}

/// Persists the per-conversation chat settings. An empty system prompt means
/// "no prompt"; empty number fields arrive as `None` and clear the value.
#[tauri::command]
pub fn set_conversation_settings(
    state: State<'_, AppState>,
    id: i64,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    context_len: Option<i64>,
    thinking: bool,
) -> CmdResult<()> {
    with_store(&state, |store| {
        let prompt = system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        store.set_conversation_settings(id, prompt, temperature, context_len, thinking)
    })
}

// ---- Message actions ---------------------------------------------------------

#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, message_id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_message(message_id))
}

/// Toggles a personal emoji reaction; `None` clears it.
#[tauri::command]
pub fn set_reaction(
    state: State<'_, AppState>,
    message_id: i64,
    reaction: Option<String>,
) -> CmdResult<()> {
    with_store(&state, |store| {
        store.set_reaction(message_id, reaction.as_deref())
    })
}

/// Copies the selected message and everything after it into a new
/// conversation. The UI only triggers it — the semantics live in the Store.
#[tauri::command]
pub fn fork_conversation(
    state: State<'_, AppState>,
    conversation_id: i64,
    message_id: i64,
) -> CmdResult<Conversation> {
    with_store(&state, |store| {
        store.fork_conversation(conversation_id, message_id)
    })
}

// ---- Search ------------------------------------------------------------------

/// Full-text search across all conversations. Hits carry the conversation
/// context so the UI can jump straight to the message.
#[tauri::command]
pub fn search_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<crate::store::SearchHit>> {
    with_store(&state, |store| store.search(&query, limit.unwrap_or(50)))
}

/// Aborts a running generation. The send pipeline notices within ~150 ms and
/// persists the partial reply.
#[tauri::command]
pub fn stop_generation(state: State<'_, AppState>, generation_id: u64) -> CmdResult<()> {
    let generations = state
        .generations
        .lock()
        .map_err(|_| "generation lock poisoned")?;
    if let Some(abort) = generations.get(&generation_id) {
        abort.abort();
    }
    Ok(())
}
