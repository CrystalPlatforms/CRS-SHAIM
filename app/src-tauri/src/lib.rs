pub mod agent;
pub mod tools;
pub mod commands;
pub mod gateway;
pub mod skills;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use tauri::Manager;

use gateway::{AbortFlag, Gateway};

/// Shared application state — the Store is the single owner of the SQLite
/// file, the SkillStore the single owner of the skill library directory,
/// the Gateway the single owner of model-server connections.
pub struct AppState {
    pub store: Mutex<store::Store>,
    pub skills: skills::SkillStore,
    pub gateway: Gateway,
    /// Monotonic id source for in-flight generations.
    pub next_generation: AtomicU64,
    /// Stop signals for generations currently streaming.
    pub generations: Mutex<HashMap<u64, AbortFlag>>,
    /// Permission asks (issue #28) waiting for the user's decision, keyed by
    /// request id. Both pipelines register here: the CLI agent path (the
    /// answer travels to the child's stdin) and the server tool loop (the
    /// answer travels through a oneshot).
    pub permissions: Mutex<HashMap<String, commands::PendingPermission>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::open(&data_dir.join("shaim.db"))?;
            let skills = skills::SkillStore::open(&data_dir.join("skills"))?;
            app.manage(AppState {
                store: Mutex::new(store),
                skills,
                gateway: Gateway::new()?,
                next_generation: AtomicU64::new(1),
                generations: Mutex::new(HashMap::new()),
                permissions: Mutex::new(HashMap::new()),
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
            commands::set_conversation_mode,
            commands::set_conversation_agent,
            commands::set_conversation_brain,
            commands::list_agent_skills,
            commands::save_attachment,
            commands::save_export,
            commands::read_attachment_data_url,
            commands::list_cli_models,
            commands::list_messages,
            commands::get_settings,
            commands::set_default_model,
            commands::set_default_system_prompt,
            commands::set_conversation_settings,
            commands::send_message,
            commands::send_agent_message,
            commands::regenerate,
            commands::edit_message,
            commands::stop_generation,
            commands::delete_message,
            commands::set_reaction,
            commands::fork_conversation,
            commands::search_messages,
            commands::list_project_files,
            commands::import_skill,
            commands::list_skills,
            commands::set_skill_enabled,
            commands::get_skill_content,
            commands::save_skill_content,
            commands::rename_skill,
            commands::delete_skill,
            commands::list_allowed_commands,
            commands::delete_allowed_command,
            commands::respond_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
