mod commands;
pub mod store;

use std::sync::Mutex;

use tauri::Manager;

/// Shared application state — the Store is the single owner of the SQLite file.
pub struct AppState {
    pub store: Mutex<store::Store>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::open(&data_dir.join("shaim.db"))?;
            app.manage(AppState {
                store: Mutex::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_conversation,
            commands::list_conversations,
            commands::rename_conversation,
            commands::delete_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
