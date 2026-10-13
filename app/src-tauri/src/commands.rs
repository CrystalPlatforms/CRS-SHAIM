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

// ---- Streamed chat -----------------------------------------------------------

/// Events pushed to the UI while a generation is running. The tag lands in
/// the `type` field of the JSON payload.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    UserMessage { id: i64, content: String, images: Vec<String> },
    Thinking { text: String },
    Content { text: String },
    TitleChanged { title: String },
    Done { message_id: i64, content: String, thinking: String, aborted: bool },
    Error { message: String },
}

/// Resolves which server/model a conversation should use: the conversation's
/// own pin, falling back to the Settings defaults.
fn resolve_target(
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
        system_prompt: conversation.system_prompt.clone(),
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
    // 1. Resolve the target and persist the user message (store lock held
    //    only here — never across the await).
    let (endpoint, model, options, user_message, title_changed) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let (endpoint, model, options) = resolve_target(&guard, conversation_id)
            .map_err(|e| e.to_string())?;
        let user_message = guard
            .insert_message_full(conversation_id, "user", &content, None, &images)
            .map_err(|e| e.to_string())?;
        let title_changed = guard
            .maybe_autotitle(conversation_id, &content)
            .map_err(|e| e.to_string())?;
        guard.touch_conversation(conversation_id).map_err(|e| e.to_string())?;
        (endpoint, model, options, user_message, title_changed)
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

    // 2. Build the request context from full history (the new user message
    //    included — it is already persisted).
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
