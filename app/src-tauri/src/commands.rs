//! Tauri command layer — thin adapters between the UI and the Store.
//!
//! No business logic here: each command maps one UI intent to one Store call.

use tauri::State;

use crate::store::{Conversation, Store};
use crate::AppState;

type CmdResult<T> = Result<T, String>;

fn with_store<T>(state: &State<'_, AppState>, f: impl FnOnce(&Store) -> crate::store::Result<T>) -> CmdResult<T> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    f(&guard).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_conversation(state: State<'_, AppState>, title: Option<String>) -> CmdResult<Conversation> {
    with_store(&state, |store| store.create_conversation(title.as_deref()))
}

#[tauri::command]
pub fn list_conversations(state: State<'_, AppState>) -> CmdResult<Vec<Conversation>> {
    with_store(&state, |store| store.list_conversations())
}

#[tauri::command]
pub fn rename_conversation(state: State<'_, AppState>, id: i64, title: String) -> CmdResult<()> {
    with_store(&state, |store| store.rename_conversation(id, &title))
}

#[tauri::command]
pub fn delete_conversation(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_conversation(id))
}
