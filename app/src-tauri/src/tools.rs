//! Local tools for Agent mode with a server-model brain: the model calls
//! them through standard function-calling, Klepai executes them on this
//! machine — everything scoped to the conversation's project folder.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::gateway::ToolCall;

/// Directories that never belong in listings or tool paths.
const SKIP_DIRS: [&str; 11] = [
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

const MAX_READ_CHARS: usize = 32_000;
const MAX_OUTPUT_CHARS: usize = 8_000;
const MAX_LISTED: usize = 200;
/// Command budget — a runaway `sleep` or build must not pin the thread.
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The tool set the model sees (OpenAI-style function schemas).
pub fn tool_specs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files in the project folder (or a subfolder of it). Returns relative paths.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Optional subfolder, relative to the project root." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a text file from the project folder. Returns its content (long files are truncated).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a text file in the project folder. Parent folders are created as needed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path, relative to the project root." },
                        "content": { "type": "string", "description": "Full file content to write." }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command inside the project folder and return combined output plus the exit code.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "The shell command to run." }
                    },
                    "required": ["command"]
                }
            }
        }
    ])
}

/// Executes one tool call against the project root. Every path argument is
/// resolved inside the root — escaping it (`..`, absolute paths) is refused.
pub async fn execute(root: &Path, call: &ToolCall) -> String {
    let args = &call.arguments;
    match call.name.as_str() {
        "list_files" => list_files(root, string_arg(args, "path").as_deref()),
        "read_file" => match string_arg(args, "path") {
            Some(path) => read_file(root, &path),
            None => "error: read_file needs a path".into(),
        },
        "write_file" => match (string_arg(args, "path"), string_arg(args, "content")) {
            (Some(path), Some(content)) => write_file(root, &path, &content),
            _ => "error: write_file needs a path and content".into(),
        },
        "run_command" => match string_arg(args, "command") {
            Some(command) => run_command(root, &command).await,
            None => "error: run_command needs a command".into(),
        },
        other => format!("error: unknown tool {other}"),
    }
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

/// Resolves a tool path inside `root`; `None` when it escapes the folder.
fn resolve_in_root(root: &Path, relative: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(relative.trim());
    if candidate.is_absolute() {
        return None;
    }
    let joined = root.join(candidate);
    let canonical_root = root.canonicalize().ok()?;
    // The file may not exist yet (write_file) — canonicalize the deepest
    // existing ancestor instead.
    let mut existing = joined.clone();
    while !existing.exists() {
        existing = existing.parent()?.to_path_buf();
    }
    let canonical = existing.canonicalize().ok()?;
    if canonical.starts_with(&canonical_root) {
        Some(joined)
    } else {
        None
    }
}

fn list_files(root: &Path, relative: Option<&str>) -> String {
    let base = match relative {
        Some(path) => match resolve_in_root(root, path) {
            Some(base) if base.is_dir() => base,
            Some(_) => return format!("error: {path} is not a folder"),
            None => return "error: path escapes the project folder".into(),
        },
        None => root.to_path_buf(),
    };
    let mut out = Vec::new();
    collect(&base, root, 0, &mut out);
    if out.is_empty() {
        return "no files found".into();
    }
    out.join("\n")
}

fn collect(dir: &Path, root: &Path, depth: u8, out: &mut Vec<String>) {
    if out.len() >= MAX_LISTED || depth > 3 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_LISTED {
            out.push(format!("… (more than {MAX_LISTED} files)"));
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
                continue;
            }
            collect(&path, root, depth + 1, out);
        } else if let Ok(relative) = path.strip_prefix(root) {
            out.push(relative.to_string_lossy().into_owned());
        }
    }
}

fn read_file(root: &Path, relative: &str) -> String {
    let Some(path) = resolve_in_root(root, relative) else {
        return "error: path escapes the project folder".into();
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            if content.chars().count() <= MAX_READ_CHARS {
                content
            } else {
                let cut: String = content.chars().take(MAX_READ_CHARS).collect();
                format!("{cut}\n… (truncated)")
            }
        }
        Err(error) => format!("error reading {}: {}", relative, shorten(&error.to_string())),
    }
}

fn write_file(root: &Path, relative: &str, content: &str) -> String {
    let Some(path) = resolve_in_root(root, relative) else {
        return "error: path escapes the project folder".into();
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return format!("error creating folders: {}", shorten(&error.to_string()));
        }
    }
    match std::fs::write(&path, content) {
        Ok(()) => format!("wrote {} ({} bytes)", relative, content.len()),
        Err(error) => format!("error writing {}: {}", relative, shorten(&error.to_string())),
    }
}

async fn run_command(root: &Path, command: &str) -> String {
    let output = tokio::time::timeout(
        COMMAND_TIMEOUT,
        tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .current_dir(root)
            .output(),
    )
    .await;

    match output {
        Err(_) => "error: command timed out after 60 s".into(),
        Ok(Err(error)) => format!("error: {}", shorten(&error.to_string())),
        Ok(Ok(output)) => {
            let mut text = String::new();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stdout.trim().is_empty() {
                text.push_str(stdout.trim_end());
            }
            if !stderr.trim().is_empty() {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str("stderr:\n");
                text.push_str(stderr.trim_end());
            }
            if let Some(code) = output.status.code().filter(|code| *code != 0) {
                text.push_str(&format!("\n\nexit code: {code}"));
            }
            if text.is_empty() {
                "(no output)".into()
            } else {
                capped(&text)
            }
        }
    }
}

/// Public cap for call-site detail strings (tool results in activity blocks).
pub fn cap_for_detail(text: &str) -> String {
    capped(text)
}

fn capped(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        text.to_string()
    } else {
        let cut: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
        format!("{cut}\n… (truncated)")
    }
}

fn shorten(text: &str) -> String {
    const MAX: usize = 200;
    if text.chars().count() <= MAX {
        text.to_string()
    } else {
        let cut: String = text.chars().take(MAX).collect();
        format!("{cut}…")
    }
}
