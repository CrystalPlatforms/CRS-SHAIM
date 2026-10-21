//! Tauri command layer — thin adapters between the UI and the Store/Gateway.
//!
//! No business logic here: each command maps one UI intent to one Store call
//! (or one Gateway call). The send pipeline is the exception — it orchestrates
//! persistence, auto-titling and streaming, which is why it lives here rather
//! than in either module.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

use crate::agent::{
    adapter_for, control_response_line, home_dir, permission_target, AgentEvent, AgentRunner,
    Segment, StdinHandle,
};
use crate::gateway::{AbortFlag, ChatEvent, ChatOptions, ChatTurn, Endpoint, ModelInfo};
use crate::skills::{self, SkillStore};
use crate::store::{
    AgentKind, AllowedKind, AllowedRule, Conversation, Message, Server, Settings, Skill, Store,
};
use crate::AppState;

type CmdResult<T> = Result<T, String>;

fn with_store<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Store) -> crate::store::Result<T>,
) -> CmdResult<T> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    f(&guard).map_err(|e| e.to_string())
}

// ---- Permissions (issue #28) ------------------------------------------------

/// Teaches the assistant Shaim's UI directives (issue #22): fenced blocks
/// with these info strings render as rich elements instead of code. Rides on
/// every request — natural chat, agent CLI prompts and the tool loop.
pub const UI_DIRECTIVES_HINT: &str = "Shaim renders these fenced blocks as rich UI elements when you emit them in a reply:\n\
- ```shaim-table with CSV (a header row, then data rows) — rendered as an interactive data table.\n\
- ```shaim-todos with JSON {\"items\":[{\"label\":\"…\",\"status\":\"pending|active|done\"}]} — rendered as a live goal-progress panel while you work; re-emit it as your plan or progress changes.\n\
- ```shaim-ts with a short label — rendered as a timestamp divider between sections.\n\
Use them sparingly, only when they genuinely help. Long multi-step tasks benefit most from shaim-todos: keep it current so the user can follow what you are doing right now.";

/// Appends the UI-directives hint to an assembled prompt.
fn with_ui_hint(mut prompt: String) -> String {
    if !prompt.is_empty() {
        prompt.push_str("\n\n---\n\n");
    }
    prompt.push_str(UI_DIRECTIVES_HINT);
    prompt
}

/// What the permission gate is willing to approve without asking. `Command`
/// names shell commands, `File` project paths, `Tool` whole tools; every
/// match is exact by design ("Allow permanently" stores exactly what was
/// shown in the ask). Public so the integration tests drive the same
/// mapping the gate uses.
pub fn rule_matches(rule: &AllowedRule, tool_name: &str, target: &str) -> bool {
    match AllowedKind::parse(&rule.kind) {
        Ok(AllowedKind::Command) => {
            (tool_name == "Bash" || tool_name == "run_command") && target == rule.pattern
        }
        Ok(AllowedKind::File) => {
            matches!(
                tool_name,
                "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "write_file"
            ) && same_path(target, &rule.pattern)
        }
        Ok(AllowedKind::Tool) => tool_name == rule.pattern,
        Err(_) => false,
    }
}

/// Exact path comparison tolerant to the `./` prefix and to one side being
/// absolute while the other is relative (both spellings of the same project
/// file are the same permission).
pub fn same_path(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    fn normalize(raw: &str) -> Vec<std::path::Component<'_>> {
        // `components()` keeps a leading `.` — drop it, both spellings of
        // one project-relative path are the same permission.
        Path::new(raw.trim())
            .components()
            .filter(|part| !matches!(part, std::path::Component::CurDir))
            .collect()
    }
    normalize(a) == normalize(b)
}

/// True when one of `rules` already covers this ask — the gate answers
/// without surfacing anything to the user.
pub fn auto_allowed(rules: &[AllowedRule], tool_name: &str, target: &str) -> bool {
    rules
        .iter()
        .any(|rule| rule_matches(rule, tool_name, target))
}

/// Which `AllowedKind` a permission ask collapses into when remembered.
fn rule_kind_for(tool_name: &str) -> AllowedKind {
    match tool_name {
        "Bash" | "run_command" => AllowedKind::Command,
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "write_file" => AllowedKind::File,
        _ => AllowedKind::Tool,
    }
}

/// The pattern a remembered rule stores: the command string, the file path,
/// or the tool name itself.
fn rule_pattern_for(tool_name: &str, target: &str) -> String {
    match rule_kind_for(tool_name) {
        AllowedKind::File => target.to_string(),
        AllowedKind::Command => target.to_string(),
        AllowedKind::Tool => tool_name.to_string(),
    }
}

/// One ask waiting for the user's decision, keyed by request id in
/// `AppState.permissions`.
pub enum PendingPermission {
    /// A CLI agent awaits a `control_response` on its stdin.
    Cli {
        stdin: StdinHandle,
        input_json: String,
        tool_name: String,
        conversation_id: i64,
    },
    /// The server-brain tool loop awaits the decision through this channel.
    Loop {
        responder: oneshot::Sender<bool>,
        tool_name: String,
        target: String,
        conversation_id: i64,
    },
}

/// Settings → Allowed: the global ("permanently") rules only.
#[tauri::command]
pub fn list_allowed_commands(state: State<'_, AppState>) -> CmdResult<Vec<AllowedRule>> {
    with_store(&state, |store| store.list_global_allowed_rules())
}

/// Removes one global rule from Settings → Allowed.
#[tauri::command]
pub fn delete_allowed_command(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_allowed_rule(id))
}

/// The user's answer to a permission ask (issue #28): allow or deny, plus
/// whether to remember it — `None` just this once, `"conversation"` for this
/// conversation forever, `"global"` for every conversation (the Settings →
/// Allowed list).
#[tauri::command]
pub async fn respond_permission(
    state: State<'_, AppState>,
    request_id: String,
    allow: bool,
    remember: Option<String>,
    conversation_id: Option<i64>,
) -> CmdResult<()> {
    let pending = state
        .permissions
        .lock()
        .map_err(|_| "permission lock poisoned")?
        .remove(&request_id);
    let Some(pending) = pending else {
        return Err("no such permission request (already answered?)".into());
    };

    let (tool_name, target, rule_conversation_id) = match pending {
        PendingPermission::Cli {
            stdin,
            input_json,
            tool_name,
            conversation_id,
        } => {
            stdin.write_line(&control_response_line(&request_id, allow, &input_json));
            let target = permission_target(&tool_name, &input_json);
            (tool_name, target, conversation_id)
        }
        PendingPermission::Loop {
            responder,
            tool_name,
            target,
            conversation_id,
        } => {
            let _ = responder.send(allow);
            (tool_name, target, conversation_id)
        }
    };

    let remember = remember.as_deref();
    if matches!(remember, Some("conversation") | Some("global")) && allow {
        let scope: Option<i64> = if remember == Some("global") {
            None
        } else {
            Some(rule_conversation_id).or(conversation_id)
        };
        let kind = rule_kind_for(&tool_name);
        let pattern = rule_pattern_for(&tool_name, &target);
        with_store(&state, |store| {
            store.add_allowed_rule(scope, kind, &pattern)
        })?;
    }
    Ok(())
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

/// Switches the conversation between Natural (chat) and Agent mode. Going
/// back to Natural keeps the agent pick — re-entering Agent mode reuses it.
#[tauri::command]
pub fn set_conversation_mode(state: State<'_, AppState>, id: i64, mode: String) -> CmdResult<()> {
    with_store(&state, |store| store.set_conversation_mode(id, &mode))
}

/// Expands a leading `~` to the user's home directory.
fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = home_dir() {
            return PathBuf::from(home);
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            let mut expanded = PathBuf::from(home);
            expanded.push(rest);
            return expanded;
        }
    }
    PathBuf::from(path)
}

/// Writes data-URL attachments to temp files so CLIs can consume them as
/// files (Codex `-i`, Claude via Read). Returns the written paths; a bad
/// payload is skipped rather than failing the send.
fn write_image_tempfiles(images: &[String]) -> Vec<PathBuf> {
    use base64::Engine;
    let mut paths = Vec::new();
    for (index, image) in images.iter().enumerate() {
        let Some((meta, payload)) = image.split_once(',') else {
            continue;
        };
        let extension = if meta.contains("image/jpeg") || meta.contains("image/jpg") {
            "jpg"
        } else if meta.contains("image/webp") {
            "webp"
        } else if meta.contains("image/gif") {
            "gif"
        } else {
            "png"
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload.trim()) else {
            continue;
        };
        let path = std::env::temp_dir().join(format!("shaim-attach-{index}.{extension}"));
        if std::fs::write(&path, bytes).is_ok() {
            paths.push(path);
        }
    }
    paths
}

/// Saves one pasted screenshot to disk (pastes have no file of their own)
/// and returns its absolute path — the composer inserts that path into the
/// message so agent brains can open the file. Files picked from disk skip
/// this entirely: their real path goes into the message untouched.
#[tauri::command]
pub fn save_attachment(data_url: String) -> CmdResult<String> {
    use base64::Engine;
    let Some((meta, payload)) = data_url.split_once(',') else {
        return Err("not a data URL".into());
    };
    let extension = if meta.contains("image/jpeg") || meta.contains("image/jpg") {
        "jpg"
    } else if meta.contains("image/webp") {
        "webp"
    } else if meta.contains("image/gif") {
        "gif"
    } else {
        "png"
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("bad image data: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!("pasted-image-{stamp}.{extension}"));
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Writes a chat export produced in the webview to the user-picked path
/// (issue #25). The payload arrives base64-encoded so every byte survives
/// the JSON bridge — docx/odt/pdf bodies are binary.
#[tauri::command]
pub fn save_export(path: String, data_base64: String) -> CmdResult<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("bad export data: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write export: {e}"))?;
    Ok(path)
}

/// Reads a picked file back as a data URL (issue #26): the native file
/// dialog only hands over paths, and the Natural-mode composer previews
/// images inline. Non-images are rejected — the composer lists those by
/// path instead.
#[tauri::command]
pub fn read_attachment_data_url(path: String) -> CmdResult<String> {
    use base64::Engine;
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return Err("not a previewable image".into()),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read file: {e}"))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Reads an image file back as a data URL (or `None` when unreadable).
fn image_data_url(path: &Path) -> Option<String> {
    use base64::Engine;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())?;
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "png" => "image/png",
        _ => return None,
    };
    let bytes = std::fs::read(path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Absolute image paths mentioned in the message text — the CLI-attachment
/// channel for paths the composer pasted.
fn extract_image_paths(text: &str) -> Vec<PathBuf> {
    const EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
    let mut paths = Vec::new();
    for token in text.split_whitespace() {
        let token = token.trim_matches(|c| c == '"' || c == '\'' || c == ')');
        let Some(rest) = token.strip_prefix('/') else {
            continue;
        };
        let lowercase = rest.to_lowercase();
        if EXTENSIONS
            .iter()
            .any(|extension| lowercase.ends_with(extension))
        {
            let path = PathBuf::from(format!("/{rest}"));
            if path.is_file() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Configures an Agent conversation in one save: which brain runs and in
/// which project folder. The folder must exist; it is canonicalized so the
/// CLI always receives an absolute, symlink-resolved path. `agent_kind`
/// `None` means the brain is the conversation's server-model pin.
#[tauri::command]
pub fn set_conversation_agent(
    state: State<'_, AppState>,
    id: i64,
    agent_kind: Option<String>,
    project_path: String,
) -> CmdResult<()> {
    let kind = match agent_kind.as_deref() {
        None => None,
        Some(raw) => Some(AgentKind::parse(raw).map_err(|e| e.to_string())?),
    };
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("project folder must not be empty".into());
    }
    let expanded = expand_home(trimmed);
    let path = expanded
        .canonicalize()
        .map_err(|_| format!("Folder does not exist: {trimmed}"))?;
    if !path.is_dir() {
        return Err(format!("Not a folder: {}", path.display()));
    }
    with_store(&state, |store| {
        store.set_conversation_agent(id, kind, &path.to_string_lossy())
    })
}

/// Switches the conversation's brain without touching the mode: a server
/// model (`None`) or one of the headless CLIs.
#[tauri::command]
pub fn set_conversation_brain(
    state: State<'_, AppState>,
    id: i64,
    agent_kind: Option<String>,
) -> CmdResult<()> {
    let kind = match agent_kind.as_deref() {
        None => None,
        Some(raw) => Some(AgentKind::parse(raw).map_err(|e| e.to_string())?),
    };
    with_store(&state, |store| store.set_conversation_brain(id, kind))
}

/// Models offered for a CLI brain: the documented aliases plus whatever
/// the user's own config pins (settings.json for Claude, config.toml for
/// Codex) — so "detection" reflects what the CLI would actually run.
#[tauri::command]
pub fn list_cli_models(agent_kind: String) -> CmdResult<Vec<String>> {
    let kind = AgentKind::parse(&agent_kind).map_err(|e| e.to_string())?;
    let Some(home) = home_dir() else {
        return Ok(vec!["default".to_string()]);
    };
    let mut models = vec!["default".to_string()];
    let push = |models: &mut Vec<String>, model: &str| {
        if !model.is_empty() && !models.iter().any(|known| known == model) {
            models.push(model.to_string());
        }
    };
    match kind {
        AgentKind::ClaudeCode => {
            // The real model set lives in settings.json's env: the main
            // ANTHROPIC_MODEL plus every ANTHROPIC_DEFAULT_*_MODEL mapping
            // (custom proxies rename the built-in aliases entirely).
            let configured = std::fs::read_to_string(home.join(".claude/settings.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            if let Some(value) = configured {
                if let Some(env) = value.get("env").and_then(serde_json::Value::as_object) {
                    for (key, model) in env {
                        let is_model = key == "ANTHROPIC_MODEL"
                            || key.starts_with("ANTHROPIC_DEFAULT_");
                        if is_model {
                            if let Some(model) = model.as_str() {
                                push(&mut models, model);
                            }
                        }
                    }
                }
            }
        }
        AgentKind::Codex => {
            // Every `model = "…"` in config.toml — the top-level pick and
            // any profile overrides…
            if let Some(text) = std::fs::read_to_string(home.join(".codex/config.toml")).ok() {
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix("model = \"") {
                        if let Some(end) = rest.rfind('"') {
                            push(&mut models, &rest[..end]);
                        }
                    }
                }
            }
            // …plus every model the user actually ran, recorded in the
            // history log and session rollouts ("model":"slug" JSON bits).
            let mut scan = |path: &Path| {
                // Session rollouts can carry non-UTF-8 bytes — scan the
                // lossy text instead of failing the whole file.
                if let Ok(bytes) = std::fs::read(path) {
                    let text = String::from_utf8_lossy(&bytes);
                    collect_json_string_values(&text, "model", &mut models);
                }
            };
            scan(&home.join(".codex/history.jsonl"));
            for dir in [".codex/sessions", ".codex/archived_sessions"] {
                let mut budget = 300i64;
                walk_jsonl_files(&home.join(dir), 0, &mut budget, &mut scan);
            }
        }
    }
    Ok(models)
}

/// Pulls every `"key":"value"` string out of JSON text (sessions are JSONL;
/// a line-based parse is enough and tolerant of trailing junk).
fn collect_json_string_values(text: &str, key: &str, out: &mut Vec<String>) {
    let needle = format!("\"{key}\":\"");
    let mut search_from = 0;
    while let Some(start) = text[search_from..].find(&needle) {
        let value_start = search_from + start + needle.len();
        let Some(end) = text[value_start..].find('"') else {
            break;
        };
        let value = &text[value_start..value_start + end];
        if !value.is_empty() && !out.iter().any(|known| known == value) {
            out.push(value.to_string());
        }
        search_from = value_start + end;
    }
}

/// Depth-limited walk over `.jsonl` files, newest last (walk order is
/// alphabetical; the cap keeps huge histories cheap).
fn walk_jsonl_files(
    dir: &Path,
    depth: u8,
    budget: &mut i64,
    visit: &mut impl FnMut(&Path),
) {
    if depth > 5 || *budget <= 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget <= 0 {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl_files(&path, depth + 1, budget, visit);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            *budget -= 1;
            visit(&path);
        }
    }
}

/// One skill (or custom command) installed for an agent CLI.
#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

/// Lists the skills/custom commands installed for an agent: its skills
/// folder (SKILL.md per directory), loose markdown command files, and any
/// plugin-provided skills under the CLI's plugin tree.
#[tauri::command]
pub fn list_agent_skills(agent_kind: String) -> CmdResult<Vec<SkillInfo>> {
    let kind = AgentKind::parse(&agent_kind).map_err(|e| e.to_string())?;
    let home = home_dir().ok_or("no home directory")?;
    let mut skills = Vec::new();
    match kind {
        AgentKind::ClaudeCode => {
            scan_skill_folders(&home.join(".claude/skills"), &mut skills);
            scan_command_files(&home.join(".claude/commands"), &mut skills);
            // Plugins ship skills too (marketplaces and versioned caches) —
            // this is where custom commands like /ask or /ship live.
            scan_skill_trees(&home.join(".claude/plugins"), &mut skills);
        }
        AgentKind::Codex => {
            scan_skill_folders(&home.join(".codex/skills"), &mut skills);
            scan_command_files(&home.join(".codex/prompts"), &mut skills);
            scan_skill_trees(&home.join(".codex/plugins"), &mut skills);
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills.dedup_by(|a, b| a.name == b.name);
    Ok(skills)
}

const SKILL_SCAN_CAP: usize = 200;

/// Depth-limited walk for `SKILL.md` files; the skill's name is the folder
/// that holds the file.
fn scan_skill_trees(root: &Path, out: &mut Vec<SkillInfo>) {
    walk_skill_files(root, 0, out);
}

fn walk_skill_files(dir: &Path, depth: u8, out: &mut Vec<SkillInfo>) {
    if depth > 6 || out.len() >= SKILL_SCAN_CAP {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_skill_files(&path, depth + 1, out);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            push_skill(&path, out);
        }
    }
}

/// Reads one SKILL.md: name from the parent folder, description from the
/// `description:` frontmatter line.
fn push_skill(skill_file: &Path, out: &mut Vec<SkillInfo>) {
    let Some(name) = skill_file
        .parent()
        .and_then(|dir| dir.file_name())
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return;
    };
    let description = std::fs::read_to_string(skill_file)
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let value = line.trim().strip_prefix("description:")?;
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_string())
            })
        })
        .unwrap_or_else(|| "Skill".to_string());
    out.push(SkillInfo {
        name,
        description: shorten_text(&description, 90),
    });
}

/// `<dir>/<name>/SKILL.md` with a `description:` frontmatter line.
fn scan_skill_folders(dir: &Path, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
            continue;
        };
        let description = std::fs::read_to_string(path.join("SKILL.md"))
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    let value = line.trim().strip_prefix("description:")?;
                    let value = value.trim();
                    (!value.is_empty()).then(|| value.to_string())
                })
            })
            .unwrap_or_else(|| "Skill".to_string());
        out.push(SkillInfo {
            name,
            description: shorten_text(&description, 90),
        });
    }
}

/// Loose `<stem>.md` command files.
fn scan_command_files(dir: &Path, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()) else {
            continue;
        };
        out.push(SkillInfo {
            name,
            description: "Custom command".to_string(),
        });
    }
}

fn shorten_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ---- Shaim skill library ------------------------------------------------------
//
// The SkillStore owns the library files; these are one-to-one adapters.
// Scope: Shaim skills reach server-model conversations only — nothing here is
// ever handed to Claude Code or Codex.

#[tauri::command]
pub fn import_skill(state: State<'_, AppState>, path: String) -> CmdResult<Skill> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    state
        .skills
        .import(&guard, Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_skills(state: State<'_, AppState>) -> CmdResult<Vec<Skill>> {
    with_store(&state, |store| store.list_skills())
}

#[tauri::command]
pub fn set_skill_enabled(state: State<'_, AppState>, id: i64, enabled: bool) -> CmdResult<()> {
    with_store(&state, |store| store.set_skill_enabled(id, enabled))
}

#[tauri::command]
pub fn get_skill_content(state: State<'_, AppState>, id: i64) -> CmdResult<String> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    state.skills.content(&guard, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_skill_content(state: State<'_, AppState>, id: i64, body: String) -> CmdResult<()> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    state
        .skills
        .save_content(&guard, id, &body)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_skill(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<()> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    state
        .skills
        .rename(&guard, id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
    state.skills.delete(&guard, id).map_err(|e| e.to_string())
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
    UserMessage { id: i64, content: String, images: Vec<String>, skill_name: Option<String> },
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
    /// Agent streams: a new collapsible activity block opens.
    ActivityStart { title: String },
    /// Agent streams: detail appended to the most recent activity block.
    ActivityAppend { detail: String },
    /// Agent streams: the most recent activity block gets a new title.
    ActivityRetitle { title: String },
    /// Agent streams: the open activity block is complete.
    ActivityEnd,
    /// The agent asked to run something that needs the user's decision
    /// (issue #28). No matching standing rule — the UI shows the three
    /// allow buttons; the answer travels back through `respond_permission`.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        target: String,
        input_json: String,
    },
    TitleChanged { title: String },
    Done { message_id: i64, content: String, thinking: String, aborted: bool },
    /// Agent runs end with a full `History` push plus this marker — a chat
    /// `Done` appends exactly one message, an agent run persists many
    /// segments, so the UI reloads instead of appending.
    AgentDone { aborted: bool, error: Option<String> },
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
    // A CLI brain has no server target — the chat commands must never
    // silently answer from a server model instead.
    if let Some(kind) = conversation.agent_kind.as_deref() {
        let label = match kind {
            "codex" => "Codex",
            _ => "Claude Code",
        };
        return Err(crate::store::StoreError::Sqlite(
            rusqlite::Error::InvalidParameterName(format!(
                "this conversation's brain is {label} — switch Brain to 'Server model' in Details to chat with your models"
            )),
        ));
    }
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
        // Reasoning is always on — a product decision, not a toggle.
        thinking: true,
    };
    Ok((endpoint_of(&server), model, options))
}

/// Skills injection — the one mapping every server-model request goes
/// through: the enabled set (capped by `SIZE_CAP_BYTES`) rides on every
/// request, and a one-shot invoked skill joins it regardless of the toggle.
/// An empty result leaves the prompt untouched.
pub fn apply_skill_injection(
    store: &Store,
    skills: &SkillStore,
    options: &mut ChatOptions,
    skill_id: Option<i64>,
) -> crate::skills::Result<()> {
    let mut prompts = skills.enabled_prompts(store)?;
    if let Some(id) = skill_id {
        prompts.push(skills.skill_prompt(store, id)?);
    }
    let block = skills::prompt_block(&prompts);
    options.system_prompt = skills::with_skill_block(options.system_prompt.take(), &block);
    // The UI-directives hint rides on every server-model request too (issue #22).
    options.system_prompt = Some(with_ui_hint(options.system_prompt.take().unwrap_or_default()));
    Ok(())
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
    skill_id: Option<i64>,
    channel: Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    // 1. Persist the user message first (auto-titling from it if this is the
    //    first one); the target itself is resolved by `stream_reply` from the
    //    persisted state (store lock held only here — never across the await).
    //    An invoked skill's name lands on the message row as display metadata.
    let (user_message, title_changed) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let skill_name = match skill_id {
            Some(id) => {
                let skill = guard.get_skill(id).map_err(|e| e.to_string())?;
                if !skill.enabled {
                    return Err(format!(
                        "skill “{}” is disabled — enable it in Settings → Skills first",
                        skill.name
                    ));
                }
                Some(skill.name)
            }
            None => None,
        };
        let user_message = guard
            .insert_message_full(
                conversation_id,
                "user",
                &content,
                None,
                &images,
                skill_name.as_deref(),
            )
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
        skill_name: user_message.skill_name.clone(),
    });
    if title_changed {
        let title = {
            let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
            guard.get_conversation(conversation_id).map_err(|e| e.to_string())?.title
        };
        let _ = channel.send(ChatStreamEvent::TitleChanged { title });
    }

    stream_reply(&state, conversation_id, skill_id, &channel).await
}

/// Streams an assistant reply for the conversation's history as stored and
/// persists it. Shared by send / regenerate / edit — all three converge on
/// "history as stored → one streamed assistant message appended", so control
/// actions reuse the exact same send/stream path. Only an explicit send can
/// carry a one-shot skill; control actions inject the enabled set alone.
async fn stream_reply(
    state: &State<'_, AppState>,
    conversation_id: i64,
    skill_id: Option<i64>,
    channel: &Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    // 1. Resolve the target from the (already persisted) state, then merge
    //    the skills block into the system prompt.
    let (endpoint, model, options) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let (endpoint, model, mut options) =
            resolve_target(&guard, conversation_id).map_err(|e| e.to_string())?;
        apply_skill_injection(&guard, &state.skills, &mut options, skill_id)
            .map_err(|e| e.to_string())?;
        (endpoint, model, options)
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
                None,
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

/// Sends the user's message through the conversation's brain. A CLI brain
/// (Claude Code, Codex) streams its work as text plus activity blocks; a
/// server-model brain in Agent mode drives a local tool loop (function
/// calling executed on this machine). Natural mode never grants computer
/// access: CLI brains run read-only, server brains run plain chat.
///
/// The whole prior conversation travels as context, so switching between
/// Natural and Agent mid-thread keeps the story intact for either brain.
#[tauri::command]
pub async fn send_agent_message(
    state: State<'_, AppState>,
    conversation_id: i64,
    content: String,
    images: Vec<String>,
    skill_id: Option<i64>,
    channel: Channel<ChatStreamEvent>,
) -> CmdResult<u64> {
    // 1. Resolve the brain and persist the prompt (store lock held only
    //    here — never across the await). The skills block (enabled set +
    //    one-shot) is assembled here too, before the lock is dropped.
    let (kind, model, cwd, access, user_message, title_changed, history, skills_block) = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        let conversation = guard
            .get_conversation(conversation_id)
            .map_err(|e| e.to_string())?;
        let kind = match conversation.agent_kind.as_deref() {
            Some(raw) => Some(AgentKind::parse(raw).map_err(|e| e.to_string())?),
            None => None,
        };
        let access = if conversation.mode == "agent" {
            crate::agent::AgentAccess::Full
        } else {
            crate::agent::AgentAccess::ReadOnly
        };
        // Agent mode works inside the project folder; Natural mode's
        // read-only runs need no folder and start in the home directory.
        let cwd = if access == crate::agent::AgentAccess::Full {
            let raw_path = conversation
                .project_path
                .clone()
                .ok_or("no project folder selected — pick one in the mode selector")?;
            let cwd = expand_home(&raw_path);
            if !cwd.is_dir() {
                return Err(format!("Project folder does not exist: {raw_path}"));
            }
            cwd
        } else {
            home_dir().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
        };
        let skill_name = match skill_id {
            Some(id) => {
                let skill = guard.get_skill(id).map_err(|e| e.to_string())?;
                if !skill.enabled {
                    return Err(format!(
                        "skill “{}” is disabled — enable it in Settings → Skills first",
                        skill.name
                    ));
                }
                Some(skill.name)
            }
            None => None,
        };
        let user_message = guard
            .insert_message_full(
                conversation_id,
                "user",
                &content,
                None,
                &images,
                skill_name.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        let title_changed = guard
            .maybe_autotitle(conversation_id, &content)
            .map_err(|e| e.to_string())?;
        guard
            .touch_conversation(conversation_id)
            .map_err(|e| e.to_string())?;
        let history = guard
            .list_messages(conversation_id)
            .map_err(|e| e.to_string())?;
        let model = conversation.model_id.clone();
        // Enabled skills ride on every agent send; the one-shot joins them.
        let skills_block = {
            let mut prompts = state
                .skills
                .enabled_prompts(&guard)
                .map_err(|e| e.to_string())?;
            if let Some(id) = skill_id {
                prompts.push(
                    state
                        .skills
                        .skill_prompt(&guard, id)
                        .map_err(|e| e.to_string())?,
                );
            }
            skills::prompt_block(&prompts)
        };
        (
            kind,
            model,
            cwd,
            access,
            user_message,
            title_changed,
            history,
            skills_block,
        )
    };

    let _ = channel.send(ChatStreamEvent::UserMessage {
        id: user_message.id,
        content: user_message.content.clone(),
        images: user_message.images.clone(),
        skill_name: user_message.skill_name.clone(),
    });
    if title_changed {
        let title = {
            let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
            guard
                .get_conversation(conversation_id)
                .map_err(|e| e.to_string())?
                .title
        };
        let _ = channel.send(ChatStreamEvent::TitleChanged { title });
    }

    // 2. Register the stop signal and run the brain.
    let generation_id = state.next_generation.fetch_add(1, Ordering::SeqCst);
    let abort = AbortFlag::new();
    state
        .generations
        .lock()
        .map_err(|_| "generation lock poisoned")?
        .insert(generation_id, abort.clone());
    let _ = channel.send(ChatStreamEvent::Started { generation_id });

    let run = async {
        match kind {
            Some(kind) => {
                let mut prompt = transcript_prompt(&history, &content);
                if !skills_block.is_empty() {
                    prompt = crate::agent::prompt_with_skills(&prompt, &skills_block);
                }
                // The UI-directives hint teaches the CLI brain Shaim's
                // renderable blocks (issue #22).
                prompt = with_ui_hint(prompt);
                // Two attachment channels: data URLs land in temp files, and
                // paths pasted into the message text are picked up as-is.
                let data_url_files = write_image_tempfiles(&images);
                let mut image_files = data_url_files.clone();
                image_files.extend(extract_image_paths(&content));
                if kind == AgentKind::ClaudeCode && !data_url_files.is_empty() {
                    // Claude has no image flag — temp-file paths ride in the
                    // prompt and the CLI opens them with its Read tool.
                    prompt.push_str(
                        "\n\nThe user attached these image files — open them with your Read tool:\n",
                    );
                    for file in &data_url_files {
                        prompt.push_str(&format!("{}\n", file.display()));
                    }
                }
                let mut adapter = adapter_for(kind);
                let stdin = StdinHandle::default();
                let permission_stdin = stdin.clone();
                AgentRunner::run(
                    adapter.as_mut(),
                    &cwd,
                    &prompt,
                    access,
                    model.as_deref(),
                    &image_files,
                    &abort,
                    &stdin,
                    |event| {
                        let mapped: Option<ChatStreamEvent> = match event {
                            AgentEvent::TextDelta { text } => {
                                Some(ChatStreamEvent::Content { text })
                            }
                            AgentEvent::ActivityStart { title } => {
                                Some(ChatStreamEvent::ActivityStart { title })
                            }
                            AgentEvent::ActivityAppend { detail } => {
                                Some(ChatStreamEvent::ActivityAppend { detail })
                            }
                            AgentEvent::ActivityRetitle { title } => {
                                Some(ChatStreamEvent::ActivityRetitle { title })
                            }
                            AgentEvent::ActivityEnd => Some(ChatStreamEvent::ActivityEnd),
                            AgentEvent::PermissionRequest {
                                request_id,
                                tool_name,
                                input_json,
                            } => {
                                // A standing rule answers without the ask
                                // ever reaching the user; otherwise the UI
                                // shows the allow buttons and the decision
                                // comes back through `respond_permission`.
                                let target = permission_target(&tool_name, &input_json);
                                let rules = {
                                    let guard =
                                        state.store.lock().expect("store lock");
                                    guard.rules_for_conversation(conversation_id)
                                };
                                match rules {
                                    Ok(ref rules)
                                        if auto_allowed(rules, &tool_name, &target) =>
                                    {
                                        permission_stdin.write_line(&control_response_line(
                                            &request_id, true, &input_json,
                                        ));
                                        None
                                    }
                                    _ => {
                                        state
                                            .permissions
                                            .lock()
                                            .expect("permission lock")
                                            .insert(
                                                request_id.clone(),
                                                PendingPermission::Cli {
                                                    stdin: permission_stdin.clone(),
                                                    input_json,
                                                    tool_name: tool_name.clone(),
                                                    conversation_id,
                                                },
                                            );
                                        Some(ChatStreamEvent::PermissionRequest {
                                            request_id,
                                            tool_name,
                                            target,
                                            input_json: String::new(),
                                        })
                                    }
                                }
                            }
                            // The runner folds Failed events into the outcome.
                            AgentEvent::Failed { .. } => Some(ChatStreamEvent::ActivityEnd),
                            // Turn boundary — the runner closed stdin, the
                            // UI learns nothing new.
                            AgentEvent::TurnEnd => None,
                        };
                        if let Some(event) = mapped {
                            let _ = channel.send(event);
                        }
                    },
                )
                .await
                .map(|outcome| (outcome.segments, outcome.error, outcome.aborted))
                .map_err(|error| error.to_string())
            }
            None if access == crate::agent::AgentAccess::Full => {
                // Image paths pasted into the message become real images
                // for vision-capable server models too.
                let mut loop_images = images.clone();
                for path in extract_image_paths(&content) {
                    if let Some(data_url) = image_data_url(&path) {
                        loop_images.push(data_url);
                    }
                }
                run_tool_loop(
                    &state,
                    conversation_id,
                    &cwd,
                    &content,
                    &loop_images,
                    skill_id,
                    &abort,
                    &channel,
                )
                    .await
                    .map(|segments| (segments, None::<String>, false))
            }
            // Natural mode with a server brain never routes here — the
            // composer sends those through send_message.
            None => Err("server models chat through the Natural composer".into()),
        }
    }
    .await;

    state
        .generations
        .lock()
        .map_err(|_| "generation lock poisoned")?
        .remove(&generation_id);

    let (segments, error, aborted) = match run {
        Ok(result) => result,
        Err(message) => {
            // Spawn-level failures (missing CLI, connect errors) persist
            // nothing; the error text carries the guidance itself.
            let _ = channel.send(ChatStreamEvent::Error { message: message.clone() });
            return Err(message);
        }
    };

    // 3. Persist every segment in order: text → assistant messages,
    //    activity blocks → `tool` messages with a JSON payload the UI
    //    unpacks into collapsible blocks.
    {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        for segment in &segments {
            match segment {
                Segment::Text(text) => {
                    guard
                        .insert_message_full(conversation_id, "assistant", text, None, &[], None)
                        .map_err(|e| e.to_string())?;
                }
                Segment::Activity { title, detail } => {
                    let payload =
                        serde_json::json!({ "title": title, "detail": detail }).to_string();
                    guard
                        .insert_message_full(conversation_id, "tool", &payload, None, &[], None)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        guard
            .touch_conversation(conversation_id)
            .map_err(|e| e.to_string())?;
        let messages = guard.list_messages(conversation_id).map_err(|e| e.to_string())?;
        let _ = channel.send(ChatStreamEvent::History { messages });
    }

    let _ = channel.send(ChatStreamEvent::AgentDone {
        aborted,
        error: error.clone(),
    });
    if let Some(error) = error {
        return Err(error);
    }
    Ok(generation_id)
}

/// The CLI prompt: everything said before, then the new message — so a brain
/// switched from another mode (or mid-thread) keeps the full story.
fn transcript_prompt(history: &[Message], content: &str) -> String {
    const MAX_PRIOR: usize = 40;
    let prior: Vec<&Message> = history[..history.len().saturating_sub(1)]
        .iter()
        .filter(|message| message.role == "user" || message.role == "assistant")
        .collect();
    if prior.is_empty() {
        return content.to_string();
    }
    let mut prompt = String::from("Earlier in this conversation, for context:\n\n");
    for message in prior.iter().rev().take(MAX_PRIOR).rev() {
        let label = if message.role == "user" { "User" } else { "Assistant" };
        prompt.push_str(&format!("{label}: {}\n\n", message.content));
    }
    prompt.push_str("The user's new message:\n");
    prompt.push_str(content);
    prompt
}

/// Agent mode with a server-model brain: a bounded tool loop. Each turn the
/// model either answers (text → assistant message) or calls tools, which
/// Shaim executes locally inside the project folder and feeds back.
async fn run_tool_loop(
    state: &State<'_, AppState>,
    conversation_id: i64,
    cwd: &Path,
    content: &str,
    images: &[String],
    skill_id: Option<i64>,
    abort: &AbortFlag,
    channel: &Channel<ChatStreamEvent>,
) -> Result<Vec<Segment>, String> {
    const MAX_ITERATIONS: usize = 12;

    let (endpoint, model, options) = {
        let guard = state.store.lock().map_err(|e| e.to_string())?;
        let (endpoint, model, mut options) =
            resolve_target(&guard, conversation_id).map_err(|e| e.to_string())?;
        apply_skill_injection(&guard, &state.skills, &mut options, skill_id)
            .map_err(|e| e.to_string())?;
        (endpoint, model, options)
    };

    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = options
        .system_prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty())
    {
        messages.push(json!({ "role": "system", "content": system }));
    }
    // Prior turns ride along as plain text context (tool blocks excluded —
    // their results are already summarized in the assistant replies).
    {
        let guard = state.store.lock().map_err(|e| e.to_string())?;
        for message in guard
            .list_messages(conversation_id)
            .map_err(|e| e.to_string())?
        {
            if matches!(message.role.as_str(), "user" | "assistant") {
                messages.push(json!({ "role": message.role, "content": message.content }));
            }
        }
    }
    // The last entry is the message being sent — drop the duplicate.
    messages.pop();
    let mut user_message = json!({ "role": "user", "content": content });
    if !images.is_empty() {
        match endpoint.kind {
            crate::store::ServerKind::Ollama => {
                user_message["images"] = json!(images
                    .iter()
                    .map(|image| crate::gateway::bare_base64(image))
                    .collect::<Vec<_>>());
            }
            crate::store::ServerKind::OpenAiCompatible => {
                let mut parts = vec![json!({ "type": "text", "text": content })];
                for image in images {
                    parts.push(json!({ "type": "image_url", "image_url": { "url": image } }));
                }
                user_message["content"] = Value::Array(parts);
            }
        }
    }
    messages.push(user_message);

    let tools = crate::tools::tool_specs();
    let mut segments: Vec<Segment> = Vec::new();

    for _ in 0..MAX_ITERATIONS {
        if abort.is_aborted() {
            break;
        }
        let outcome = state
            .gateway
            .complete(
                &endpoint,
                &model,
                messages.clone(),
                Some(&tools),
                &options,
                abort,
            )
            .await
            .map_err(|error| error.to_string())?;

        if !outcome.thinking.is_empty() {
            emit_activity(channel, &mut segments, "Thinking", &outcome.thinking);
        }
        if !outcome.content.is_empty() {
            segments.push(Segment::Text(outcome.content.clone()));
        }
        if outcome.tool_calls.is_empty() {
            break;
        }

        // Mirror the assistant turn (text + calls) for the next request.
        let calls_json: Vec<Value> = outcome
            .tool_calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": serde_json::to_string(&call.arguments)
                            .unwrap_or_else(|_| "{}".into()),
                    },
                })
            })
            .collect();
        let mut assistant = json!({ "role": "assistant", "content": outcome.content });
        assistant["tool_calls"] = Value::Array(calls_json);
        messages.push(assistant);

        for call in outcome.tool_calls {
            if abort.is_aborted() {
                break;
            }
            let (running, done, head) = tool_block_titles(&call);
            let _ = channel.send(ChatStreamEvent::ActivityStart { title: running });
            // Permission gate (issue #28): commands and file writes ask the
            // user first unless a standing rule already covers them.
            let arguments_json =
                serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into());
            let target = permission_target(&call.name, &arguments_json);
            let allowed = {
                let rules = {
                    let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
                    guard
                        .rules_for_conversation(conversation_id)
                        .map_err(|e| e.to_string())?
                };
                if auto_allowed(&rules, &call.name, &target) {
                    true
                } else {
                    ask_permission(state, channel, conversation_id, &call.name, &target, abort)
                        .await
                }
            };
            let result = if allowed {
                crate::tools::execute(cwd, &call).await
            } else {
                format!(
                    "error: the user denied running `{target}` — do not retry it without asking."
                )
            };
            let detail = format!("{head}\n\n→ {}", crate::tools::cap_for_detail(&result));
            let _ = channel.send(ChatStreamEvent::ActivityAppend { detail: detail.clone() });
            let _ = channel.send(ChatStreamEvent::ActivityRetitle { title: done.clone() });
            let _ = channel.send(ChatStreamEvent::ActivityEnd);
            segments.push(Segment::Activity {
                title: done.clone(),
                detail,
            });
            // Feed the result back — the tool role is spelled the same for
            // both dialects except for OpenAI's tool_call_id.
            let mut tool_message = json!({ "role": "tool", "content": result });
            if endpoint.kind == crate::store::ServerKind::OpenAiCompatible {
                tool_message["tool_call_id"] = json!(call.id);
            }
            messages.push(tool_message);
        }
    }
    Ok(segments)
}

/// Surfaces one permission ask to the UI and waits for the decision
/// (server-brain tool loop path, issue #28). Stop ends the wait as a denial;
/// the pending entry is always cleaned up.
async fn ask_permission(
    state: &State<'_, AppState>,
    channel: &Channel<ChatStreamEvent>,
    conversation_id: i64,
    tool_name: &str,
    target: &str,
    abort: &AbortFlag,
) -> bool {
    let request_id = format!(
        "loop-{}",
        state.next_generation.fetch_add(1, Ordering::SeqCst)
    );
    let (responder, mut receiver) = oneshot::channel();
    state
        .permissions
        .lock()
        .expect("permission lock")
        .insert(
            request_id.clone(),
            PendingPermission::Loop {
                responder,
                tool_name: tool_name.to_string(),
                target: target.to_string(),
                conversation_id,
            },
        );
    let _ = channel.send(ChatStreamEvent::PermissionRequest {
        request_id: request_id.clone(),
        tool_name: tool_name.to_string(),
        target: target.to_string(),
        input_json: String::new(),
    });

    let mut allowed = false;
    loop {
        if abort.is_aborted() {
            break;
        }
        match receiver.try_recv() {
            Ok(answer) => {
                allowed = answer;
                break;
            }
            Err(oneshot::error::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(oneshot::error::TryRecvError::Closed) => break,
        }
    }
    // `respond_permission` removed the entry on an answer; an aborted or
    // abandoned ask leaves it behind — drop it either way.
    state
        .permissions
        .lock()
        .expect("permission lock")
        .remove(&request_id);
    allowed
}

/// Emits a reasoning/activity block the same way the CLI path does.
fn emit_activity(
    channel: &Channel<ChatStreamEvent>,
    segments: &mut Vec<Segment>,
    title: &str,
    detail: &str,
) {
    let _ = channel.send(ChatStreamEvent::ActivityStart {
        title: title.to_string(),
    });
    let _ = channel.send(ChatStreamEvent::ActivityAppend {
        detail: detail.to_string(),
    });
    let _ = channel.send(ChatStreamEvent::ActivityEnd);
    segments.push(Segment::Activity {
        title: title.to_string(),
        detail: detail.to_string(),
    });
}

/// (running title, done title, detail head) for one local tool call.
fn tool_block_titles(call: &crate::gateway::ToolCall) -> (String, String, String) {
    let arguments = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into());
    let string_arg = |key: &str| {
        call.arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    match call.name.as_str() {
        "run_command" => {
            let command = string_arg("command");
            (
                format!("Running $ {command}"),
                format!("Ran $ {command}"),
                arguments,
            )
        }
        "read_file" => {
            let path = string_arg("path");
            (
                format!("Reading {path}"),
                format!("Read {path}"),
                arguments,
            )
        }
        "write_file" => {
            let path = string_arg("path");
            (
                format!("Writing {path}"),
                format!("Wrote {path}"),
                arguments,
            )
        }
        "list_files" => {
            let path = string_arg("path");
            let target = if path.is_empty() { "project".to_string() } else { path };
            (
                format!("Listing {target}"),
                format!("Listed {target}"),
                arguments,
            )
        }
        other => (
            format!("Calling {other}"),
            format!("Called {other}"),
            arguments,
        ),
    }
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
    stream_reply(&state, conversation_id, None, &channel).await
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
    stream_reply(&state, conversation_id, None, &channel).await
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
) -> CmdResult<()> {
    with_store(&state, |store| {
        let prompt = system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        store.set_conversation_settings(id, prompt, temperature, context_len)
    })
}

// ---- Message actions ---------------------------------------------------------

#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, message_id: i64) -> CmdResult<()> {
    with_store(&state, |store| store.delete_message(message_id))
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

// ---- Agent composer helpers --------------------------------------------------

/// Build directories that never belong in an '@' mention list.
const SKIP_PROJECT_DIRS: [&str; 11] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

/// Relative paths inside the conversation's project folder, for the '@'
/// mention palette. Shallow walk (depth 4), noise dirs skipped, `limit` cap.
#[tauri::command]
pub fn list_project_files(
    state: State<'_, AppState>,
    conversation_id: i64,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<String>> {
    let project_path = {
        let guard = state.store.lock().map_err(|_| "store lock poisoned")?;
        guard
            .get_conversation(conversation_id)
            .map_err(|e| e.to_string())?
            .project_path
            .ok_or("no project folder selected — pick one in the mode selector")?
    };
    let root = expand_home(&project_path);
    if !root.is_dir() {
        return Err(format!("Project folder does not exist: {project_path}"));
    }
    let query_lc = query.to_lowercase();
    let mut files = Vec::new();
    collect_project_files(
        &root,
        &root,
        &query_lc,
        limit.unwrap_or(30),
        0,
        &mut files,
    );
    Ok(files)
}

fn collect_project_files(
    dir: &Path,
    root: &Path,
    query: &str,
    limit: usize,
    depth: u8,
    out: &mut Vec<String>,
) {
    if out.len() >= limit || depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if SKIP_PROJECT_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
                continue;
            }
            collect_project_files(&path, root, query, limit, depth + 1, out);
        } else {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            if !query.is_empty() && !relative.to_lowercase().contains(query) {
                continue;
            }
            out.push(relative);
        }
    }
}
