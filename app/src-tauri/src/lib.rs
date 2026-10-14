pub mod commands;
pub mod gateway;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use tauri::Manager;

use gateway::{AbortFlag, Gateway};

/// Shared application state — the Store is the single owner of the SQLite
/// file, the Gateway the single owner of model-server connections.
pub struct AppState {
    pub store: Mutex<store::Store>,
    pub gateway: Gateway,
    /// Monotonic id source for in-flight generations.
    pub next_generation: AtomicU64,
    /// Stop signals for generations currently streaming.
    pub generations: Mutex<HashMap<u64, AbortFlag>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::open(&data_dir.join("shaim.db"))?;
            app.manage(AppState {
                store: Mutex::new(store),
                gateway: Gateway::new()?,
                next_generation: AtomicU64::new(1),
                generations: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_server,
            commands::list_servers,
            commands::update_server,
            commands::delete_server,
            commands::list_server_models,
            commands::create_conversation,
            commands::list_conversations,
            commands::get_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::set_conversation_model,
            commands::list_messages,
            commands::get_settings,
            commands::set_default_model,
            commands::set_default_system_prompt,
            commands::set_conversation_settings,
            commands::send_message,
            commands::regenerate,
            commands::edit_message,
            commands::stop_generation,
            commands::delete_message,
            commands::set_reaction,
            commands::fork_conversation,
            commands::search_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
