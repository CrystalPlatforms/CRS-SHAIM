//! AgentRunner — the only component that spawns headless coding-agent CLIs.
//!
//! Deep module: the rest of the app cannot tell Claude Code and Codex apart.
//! Surface:
//!
//! - [`AgentKind`] — which agent (mirrors `store::AgentKind`)
//! - [`AgentAdapter`] — one adapter per CLI: how to spawn it headless and how
//!   to turn its stdout lines into [`AgentEvent`]s
//! - [`AgentRunner::run`] — spawns in the project folder, streams events as
//!   they arrive, abortable via the shared [`AbortFlag`], and folds the
//!   stream into ordered [`Segment`]s for persistence
//!
//! Agents never touch the ModelGateway or model servers — they are their own
//! binaries talking to their own providers. The adapters are isolated
//! precisely because headless flags drift between CLI versions; both were
//! verified against the installed versions at implementation time
//! (claude 2.1.299, codex-cli 0.162.1).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::gateway::AbortFlag;
use crate::store::AgentKind;

/// Activity detail is capped so a chatty tool output cannot flood the chat.
const MAX_ACTIVITY_DETAIL: usize = 8192;
/// How often the abort flag is re-checked while waiting for stdout — keeps
/// Stop responsive even when the agent produces nothing for a while.
const ABORT_POLL: Duration = Duration::from_millis(150);

/// One streamed piece of agent output. Text deltas fold into assistant
/// messages; activity pieces fold into collapsible tool/activity blocks.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    TextDelta { text: String },
    /// Opens a new activity block (tool call, thinking, command run…).
    ActivityStart { title: String },
    /// Appends detail to the most recent activity block.
    ActivityAppend { detail: String },
    /// Renames the most recent activity block — e.g. once a Claude tool
    /// input finished streaming and the actual command/file is known.
    ActivityRetitle { title: String },
    /// The open activity block is complete.
    ActivityEnd,
    /// The agent reported its own failure (the stream still ends normally).
    Failed { message: String },
}

/// The failure modes of an agent run. `MissingBinary` is structured so the
/// UI can say exactly which CLI is absent and how to install it.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("{label} CLI not found. Install it first — {install_hint}")]
    MissingBinary {
        binary: String,
        label: &'static str,
        install_hint: &'static str,
    },
    #[error("Failed to start the agent CLI: {0}")]
    Spawn(String),
    #[error("Agent exited with code {code} before finishing{tail}")]
    Exit { code: i32, tail: String },
    #[error("Agent stream error: {0}")]
    Io(String),
}

/// One ordered piece of a finished agent run — what persistence saves and
/// what the streaming UI accumulates live.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Text(String),
    Activity { title: String, detail: String },
}

/// Final state of one agent run: the folded segments (whatever arrived,
/// partial included), whether Stop was used, and the error if the run failed.
#[derive(Debug, Clone, Default)]
pub struct AgentOutcome {
    pub segments: Vec<Segment>,
    pub aborted: bool,
    pub error: Option<String>,
}

/// How much of the computer the agent may touch. Natural mode chats through
/// the same CLI with read-only permissions; Agent mode lets it work in the
/// project folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentAccess {
    /// No writes, no commands — the CLI may only read and reason.
    ReadOnly,
    /// Full access inside the project folder.
    Full,
}

/// One adapter per agent CLI: how to spawn it headless in a project folder
/// and how to read its stdout. `parse_line` may keep per-run state (Codex
/// pairs started/completed items); adapters are created fresh per run.
pub trait AgentAdapter: Send {
    fn label(&self) -> &'static str;
    fn binary(&self) -> &'static str;
    /// One-line install guidance shown when the binary is missing.
    fn install_hint(&self) -> &'static str;
    /// `images` are pre-written temp files for the CLIs that take file
    /// attachments (Codex `-i`); CLIs without a flag read them via their
    /// file tools from prompt references the caller adds instead.
    fn build_command(
        &self,
        cwd: &Path,
        prompt: &str,
        access: AgentAccess,
        model: Option<&str>,
        images: &[PathBuf],
    ) -> Command;
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent>;
}

pub fn adapter_for(kind: AgentKind) -> Box<dyn AgentAdapter> {
    match kind {
        AgentKind::ClaudeCode => Box::new(ClaudeCodeAdapter::default()),
        AgentKind::Codex => Box::new(CodexAdapter::default()),
    }
}

/// GUI-launched apps on macOS get a bare PATH that never includes the usual
/// CLI install spots (`~/.local/bin`, Homebrew). Prepending the common ones
/// keeps agent spawning working outside `npm run tauri dev`.
fn augment_path(command: &mut Command) {
    const EXTRA: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "/bin"];
    let mut paths: Vec<String> = EXTRA.iter().map(|p| p.to_string()).collect();
    if let Some(home) = std::env::var_os("HOME") {
        let mut home_bin = PathBuf::from(home);
        home_bin.push(".local/bin");
        paths.push(home_bin.to_string_lossy().into_owned());
    }
    if let Ok(existing) = std::env::var("PATH") {
        paths.push(existing);
    }
    command.env("PATH", paths.join(":"));
}

pub struct AgentRunner;

impl AgentRunner {
    /// Spawns the adapter's CLI headless in `cwd`, forwards every parsed
    /// event through `on_event`, and folds the whole stream into segments.
    /// Stop (`abort`) kills the child process; the segments collected so far
    /// come back with `aborted = true`.
    pub async fn run(
        adapter: &mut dyn AgentAdapter,
        cwd: &Path,
        prompt: &str,
        access: AgentAccess,
        model: Option<&str>,
        images: &[PathBuf],
        abort: &AbortFlag,
        mut on_event: impl FnMut(AgentEvent),
    ) -> Result<AgentOutcome, AgentError> {
        let mut command = adapter.build_command(cwd, prompt, access, model, images);
        augment_path(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AgentError::MissingBinary {
                    binary: adapter.binary().to_string(),
                    label: adapter.label(),
                    install_hint: adapter.install_hint(),
                }
            } else {
                AgentError::Spawn(error.to_string())
            }
        })?;

        let mut stdout = tokio::io::BufReader::new(
            child
                .stdout
                .take()
                .expect("agent child stdout should be piped"),
        )
        .lines();
        // Stderr is only kept for error messages — a capped tail of it rides
        // along when the run fails.
        let stderr_tail = drain_stderr(
            child
                .stderr
                .take()
                .expect("agent child stderr should be piped"),
        );

        let mut fold = SegmentFolder::default();
        let mut failed: Option<String> = None;
        let mut aborted = false;

        loop {
            if abort.is_aborted() {
                let _ = child.start_kill();
                aborted = true;
                break;
            }
            let line = tokio::select! {
                _ = tokio::time::sleep(ABORT_POLL) => continue,
                item = stdout.next_line() => match item {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(error) => {
                        if abort.is_aborted() {
                            aborted = true;
                        } else {
                            let _ = child.start_kill();
                            failed = Some(format!("stdout read failed: {error}"));
                        }
                        break;
                    }
                },
            };

            for event in adapter.parse_line(line.trim()) {
                match event {
                    AgentEvent::Failed { message } => failed = Some(message),
                    other => {
                        fold.apply(&other);
                        on_event(other);
                    }
                }
            }
        }

        // Observe the child's exit — after a kill this is what proves the
        // process actually terminated.
        let status = child
            .wait()
            .await
            .map_err(|error| AgentError::Io(error.to_string()))?;
        let tail = stderr_tail.tail();

        let mut outcome = fold.finish();
        outcome.aborted = aborted;
        if let Some(message) = failed {
            outcome.error = Some(message);
        } else if !aborted && !status.success() {
            outcome.error = Some(AgentError::Exit {
                code: status.code().unwrap_or(-1),
                tail,
            }
            .to_string());
        }
        // A killed agent usually exits non-zero — Stop wins, no error.
        Ok(outcome)
    }
}

/// Capped stderr accumulator: the last few kilobytes, for error messages.
fn drain_stderr(stderr: tokio::process::ChildStderr) -> std::sync::Arc<StderrTail> {
    use tokio::io::AsyncReadExt;
    let tail = std::sync::Arc::new(StderrTail::default());
    let sink = tail.clone();
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut buffer = [0u8; 2048];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => sink.push(&buffer[..read]),
            }
        }
    });
    tail
}

#[derive(Default)]
struct StderrTail(std::sync::Mutex<Vec<u8>>);

const STDERR_CAP: usize = 4096;

impl StderrTail {
    fn push(&self, bytes: &[u8]) {
        let mut guard = self.0.lock().expect("stderr lock");
        guard.extend_from_slice(bytes);
        if guard.len() > STDERR_CAP {
            let excess = guard.len() - STDERR_CAP;
            guard.drain(..excess);
        }
    }

    fn tail(&self) -> String {
        let guard = self.0.lock().expect("stderr lock");
        String::from_utf8_lossy(&guard).trim().to_string()
    }
}

/// Folds the event stream into ordered segments — the same shape persistence
/// saves, so the streaming view and the stored thread never disagree.
#[derive(Default)]
struct SegmentFolder {
    segments: Vec<Segment>,
    failed: Option<String>,
}

impl SegmentFolder {
    fn apply(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::TextDelta { text } => {
                if let Some(Segment::Text(existing)) = self.segments.last_mut() {
                    existing.push_str(text);
                } else {
                    self.segments.push(Segment::Text(text.clone()));
                }
            }
            AgentEvent::ActivityStart { title } => {
                self.segments.push(Segment::Activity {
                    title: title.clone(),
                    detail: String::new(),
                });
            }
            AgentEvent::ActivityAppend { detail } => {
                // Targets the most recent activity block regardless of whether
                // it is still open — tool results arrive right after their
                // block closed.
                if let Some(Segment::Activity { detail: existing, .. }) =
                    self.segments.last_mut()
                {
                    append_capped(existing, detail);
                }
            }
            AgentEvent::ActivityRetitle { title } => {
                if let Some(Segment::Activity {
                    title: existing, ..
                }) = self.segments.last_mut()
                {
                    *existing = title.clone();
                }
            }
            AgentEvent::ActivityEnd => {}
            AgentEvent::Failed { message } => self.failed = Some(message.clone()),
        }
    }

    fn finish(self) -> AgentOutcome {
        AgentOutcome {
            // Empty text segments (a text block that never received deltas)
            // would persist as blank assistant messages — drop them.
            segments: self
                .segments
                .into_iter()
                .filter(|segment| !matches!(segment, Segment::Text(text) if text.is_empty()))
                .collect(),
            aborted: false,
            error: self.failed,
        }
    }
}

fn append_capped(target: &mut String, addition: &str) {
    if target.chars().count() >= MAX_ACTIVITY_DETAIL {
        return;
    }
    target.push_str(addition);
    if target.chars().count() > MAX_ACTIVITY_DETAIL {
        let cut: String = target.chars().take(MAX_ACTIVITY_DETAIL).collect();
        *target = format!("{cut}…");
    }
}

/// Truncates a single-line title on a char boundary.
fn short_title(text: &str, max: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Raw text capped on a char boundary — detail keeps its line breaks.
fn capped(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ---- Claude Code -----------------------------------------------------------

/// Adapter for `claude -p --output-format stream-json`. Spawned with
/// `--include-partial-messages`, so stdout carries Anthropic-style
/// `stream_event` lines (text/thinking deltas, tool_use blocks) plus `user`
/// lines carrying tool results; complete `assistant` lines are duplicates of
/// what the deltas already delivered and are ignored — except when the CLI
/// ever stops emitting partials, in which case they degrade gracefully into
/// the only source of content.
#[derive(Default)]
pub struct ClaudeCodeAdapter {
    /// Kind of the currently open content block, if any.
    open_block: OpenBlock,
    /// Name of the open tool_use block ("Bash", "Read"…), for the verbs.
    open_tool_name: String,
    /// Accumulated `input_json_delta` pieces of the open tool_use block.
    tool_input: String,
    /// The tool whose result is still owed: its title target and the
    /// past-tense verb — consumed by the next tool_result line.
    pending_tool: Option<(String, &'static str)>,
    /// Whether any `stream_event` line was seen (switches duplicate
    /// suppression of complete `assistant` lines on).
    saw_partials: bool,
}

#[derive(Default, PartialEq)]
enum OpenBlock {
    #[default]
    None,
    Thinking,
    Tool,
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn install_hint(&self) -> &'static str {
        "npm install -g @anthropic-ai/claude-code (https://code.claude.com/docs)"
    }

    fn build_command(
        &self,
        cwd: &Path,
        prompt: &str,
        access: AgentAccess,
        model: Option<&str>,
        images: &[PathBuf],
    ) -> Command {
        let mut command = Command::new(self.binary());
        command
            .current_dir(cwd)
            .args([
                "-p",
                prompt,
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                // Headless runs cannot answer permission prompts. Agent mode
                // accepts edits inside the folder; Natural mode stays in plan
                // permissions — the model may look around but change nothing.
                "--permission-mode",
                match access {
                    AgentAccess::Full => "acceptEdits",
                    AgentAccess::ReadOnly => "plan",
                },
            ]);
        if let Some(model) = model.filter(|model| !model.is_empty() && *model != "default") {
            command.arg("--model").arg(model);
        }
        // Headless runs may only read the working directory — attachments
        // live outside it, so each image's folder is granted explicitly.
        let mut added_dirs: Vec<PathBuf> = Vec::new();
        for image in images {
            if let Some(dir) = image.parent() {
                if !added_dirs.contains(&dir.to_path_buf()) {
                    added_dirs.push(dir.to_path_buf());
                    command.arg("--add-dir").arg(dir);
                }
            }
        }
        command.env("CLAUDE_CODE_ENTRYPOINT", "shaim");
        command
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("stream_event") => {
                self.saw_partials = true;
                self.parse_stream_event(&value["event"])
            }
            Some("user") => self.parse_tool_results(&value["message"]),
            Some("assistant") if !self.saw_partials => {
                self.parse_complete_blocks(&value["message"])
            }
            Some("result") => self.parse_result(&value),
            _ => Vec::new(),
        }
    }
}

impl ClaudeCodeAdapter {
    fn parse_stream_event(&mut self, event: &serde_json::Value) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        match event.get("type").and_then(serde_json::Value::as_str) {
            Some("content_block_start") => {
                let block = &event["content_block"];
                match block.get("type").and_then(serde_json::Value::as_str) {
                    Some("thinking") => {
                        self.open_block = OpenBlock::Thinking;
                        events.push(AgentEvent::ActivityStart {
                            title: "Thinking".into(),
                        });
                    }
                    Some("tool_use") => {
                        self.open_block = OpenBlock::Tool;
                        self.tool_input.clear();
                        self.open_tool_name = block
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Tool")
                            .to_string();
                        events.push(AgentEvent::ActivityStart {
                            title: self.open_tool_name.clone(),
                        });
                    }
                    _ => self.open_block = OpenBlock::None,
                }
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta.get("type").and_then(serde_json::Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(serde_json::Value::as_str)
                        {
                            events.push(AgentEvent::TextDelta { text: text.into() });
                        }
                    }
                    Some("thinking_delta") => {
                        if self.open_block != OpenBlock::Thinking {
                            // Defensively open a Thinking block if deltas
                            // ever arrive without their start event.
                            self.open_block = OpenBlock::Thinking;
                            events.push(AgentEvent::ActivityStart {
                                title: "Thinking".into(),
                            });
                        }
                        if let Some(text) =
                            delta.get("thinking").and_then(serde_json::Value::as_str)
                        {
                            events.push(AgentEvent::ActivityAppend { detail: text.into() });
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(piece) =
                            delta.get("partial_json").and_then(serde_json::Value::as_str)
                        {
                            self.tool_input.push_str(piece);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if self.open_block == OpenBlock::Tool && !self.tool_input.is_empty() {
                    let input = compact_json(&self.tool_input);
                    if !input.is_empty() {
                        // Name what the tool is doing right in the title —
                        // "Running $ git status", "Reading app.rs" — and
                        // remember it so the result line flips it to the
                        // past tense ("Ran", "Read").
                        if let Some(target) = tool_target(&self.tool_input) {
                            let (running, done) = tool_verbs(&self.open_tool_name);
                            events.push(AgentEvent::ActivityRetitle {
                                title: format!("{running} {target}"),
                            });
                            self.pending_tool = Some((target, done));
                        }
                        events.push(AgentEvent::ActivityAppend { detail: input });
                    }
                }
                if self.open_block != OpenBlock::None {
                    events.push(AgentEvent::ActivityEnd);
                }
                self.open_block = OpenBlock::None;
                self.tool_input.clear();
                self.open_tool_name.clear();
            }
            _ => {}
        }
        events
    }

    /// `user` lines carry the tool results of the block that just closed —
    /// the moment the running verb turns past ("Running $ git status" →
    /// "Ran $ git status").
    fn parse_tool_results(&mut self, message: &serde_json::Value) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        let mut saw_result = false;
        if let Some(blocks) = message.get("content").and_then(serde_json::Value::as_array) {
            for block in blocks {
                if block.get("type").and_then(serde_json::Value::as_str) != Some("tool_result") {
                    continue;
                }
                saw_result = true;
                let text = match block.get("content") {
                    Some(serde_json::Value::String(text)) => text.clone(),
                    Some(serde_json::Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                if !text.is_empty() {
                    events.push(AgentEvent::ActivityAppend {
                        detail: format!("\n\n→ {}", capped(&text, MAX_ACTIVITY_DETAIL - 4)),
                    });
                }
            }
        }
        if saw_result {
            if let Some((target, done)) = self.pending_tool.take() {
                // The retitle lands before the appended result so the block
                // reads "Ran $ …" the moment its output appears.
                events.insert(0, AgentEvent::ActivityRetitle {
                    title: format!("{done} {target}"),
                });
            }
        }
        events
    }

    /// Complete `assistant` lines (fallback path when the CLI emits no
    /// partial messages): every content block becomes events in one go.
    fn parse_complete_blocks(&mut self, message: &serde_json::Value) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        if let Some(blocks) = message.get("content").and_then(serde_json::Value::as_array) {
            for block in blocks {
                match block.get("type").and_then(serde_json::Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(serde_json::Value::as_str)
                        {
                            events.push(AgentEvent::TextDelta { text: text.into() });
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) =
                            block.get("thinking").and_then(serde_json::Value::as_str)
                        {
                            events.push(AgentEvent::ActivityStart {
                                title: "Thinking".into(),
                            });
                            events.push(AgentEvent::ActivityAppend { detail: text.into() });
                            events.push(AgentEvent::ActivityEnd);
                        }
                    }
                    Some("tool_use") => {
                        let name = block
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Tool");
                        events.push(AgentEvent::ActivityStart {
                            title: name.to_string(),
                        });
                        let raw_input = block.get("input").map(|input| input.to_string());
                        if let Some(raw) = &raw_input {
                            if let Some(target) = tool_target(raw) {
                                // Complete lines arrive after the fact — the
                                // past-tense verb right away.
                                let (_, done) = tool_verbs(name);
                                events.push(AgentEvent::ActivityRetitle {
                                    title: format!("{done} {target}"),
                                });
                            }
                            let detail = compact_json(raw);
                            if !detail.is_empty() {
                                events.push(AgentEvent::ActivityAppend { detail });
                            }
                        }
                        events.push(AgentEvent::ActivityEnd);
                    }
                    _ => {}
                }
            }
        }
        events
    }

    fn parse_result(&mut self, value: &serde_json::Value) -> Vec<AgentEvent> {
        let is_error = value
            .get("is_error")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let subtype = value
            .get("subtype")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if is_error || subtype.starts_with("error") {
            let detail = value
                .get("result")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(subtype);
            return vec![AgentEvent::Failed {
                message: format!("Claude Code finished with an error: {detail}"),
            }];
        }
        Vec::new()
    }
}

/// Compacts a tool-call input JSON string for the activity detail: re-serialized
/// without whitespace, or the raw text when it is not valid JSON.
fn compact_json(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string()),
        Err(_) => raw.to_string(),
    }
}

/// A readable block title from a Claude tool input: the command itself for
/// shell tools ("$ git status"), the file for the file tools ("src/app.rs").
/// `None` keeps the plain tool name.
fn tool_target(raw_input: &str) -> Option<String> {
    let input = serde_json::from_str::<serde_json::Value>(raw_input).ok()?;
    if let Some(command) = input.get("command").and_then(serde_json::Value::as_str) {
        if !command.trim().is_empty() {
            return Some(format!("$ {}", short_title(command, 72)));
        }
    }
    let path = ["file_path", "path", "notebook_path"]
        .iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_str))
        .filter(|path| !path.trim().is_empty())?;
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    Some(short_title(&name, 48))
}

/// How a Claude tool reads in the thread, while it works and once its result
/// landed: "Running $ git status" → "Ran $ git status", "Reading app.rs" →
/// "Read app.rs". Unknown tools fall back to their bare name when done.
fn tool_verbs(name: &str) -> (&'static str, &'static str) {
    match name {
        "Bash" => ("Running", "Ran"),
        "Read" => ("Reading", "Read"),
        "Write" => ("Writing", "Wrote"),
        "Edit" | "MultiEdit" | "NotebookEdit" => ("Editing", "Edited"),
        "Glob" | "Grep" | "WebSearch" => ("Searching", "Searched"),
        "WebFetch" => ("Fetching", "Fetched"),
        "Task" => ("Delegating", "Delegated"),
        "TodoWrite" => ("Planning", "Planned"),
        _ => ("Running", "Finished"),
    }
}

// ---- Codex -----------------------------------------------------------------

/// Adapter for `codex exec --json`. Stdout is JSONL of thread/turn/item
/// events; `agent_message` items are the replies, every other item kind is
/// an activity block (command executions, reasoning, file changes…).
#[derive(Default)]
pub struct CodexAdapter {
    /// Started item ids → the activity title they opened.
    open_items: HashMap<String, String>,
}

impl AgentAdapter for CodexAdapter {
    fn label(&self) -> &'static str {
        "Codex"
    }

    fn binary(&self) -> &'static str {
        "codex"
    }

    fn install_hint(&self) -> &'static str {
        "npm install -g @openai/codex (https://developers.openai.com/codex/cli)"
    }

    fn build_command(
        &self,
        cwd: &Path,
        prompt: &str,
        access: AgentAccess,
        model: Option<&str>,
        images: &[PathBuf],
    ) -> Command {
        let mut command = Command::new(self.binary());
        command
            .current_dir(cwd)
            // `--skip-git-repo-check`: a scratch project folder is not a git
            // repo. The sandbox matches the mode: workspace-write lets the
            // agent work in the folder, read-only only lets it look.
            .args(["exec", "--json", "--skip-git-repo-check", "--sandbox"])
            .arg(match access {
                AgentAccess::Full => "workspace-write",
                AgentAccess::ReadOnly => "read-only",
            })
            .arg("--cd")
            .arg(cwd);
        if let Some(model) = model.filter(|model| !model.is_empty() && *model != "default") {
            command.arg("-m").arg(model);
        }
        command
            // The prompt goes BEFORE `-i`: that flag is variadic and would
            // swallow a trailing positional as another image, leaving codex
            // without any prompt (it then waits on stdin and fails).
            .arg(prompt);
        for image in images {
            command.arg("-i").arg(image);
        }
        command
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("item.started") => match value.get("item") {
                Some(item) => self.parse_item(ItemPhase::Started(item)),
                None => Vec::new(),
            },
            Some("item.completed") => match value.get("item") {
                Some(item) => self.parse_item(ItemPhase::Completed(item)),
                None => Vec::new(),
            },
            Some("turn.failed") => {
                let message = value
                    .pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("turn failed");
                vec![AgentEvent::Failed {
                    message: format!("Codex failed: {message}"),
                }]
            }
            _ => Vec::new(),
        }
    }
}

enum ItemPhase<'a> {
    Started(&'a serde_json::Value),
    Completed(&'a serde_json::Value),
}

impl CodexAdapter {
    fn parse_item(&mut self, item: ItemPhase<'_>) -> Vec<AgentEvent> {
        let value = match item {
            ItemPhase::Started(value) | ItemPhase::Completed(value) => value,
        };
        let kind = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let id = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        match (kind, item) {
            // Replies arrive complete (no item.started counterpart).
            ("agent_message", ItemPhase::Completed(_)) => {
                let text = value
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![AgentEvent::TextDelta { text: text.into() }]
                }
            }
            ("error", ItemPhase::Completed(_)) => {
                let message = value
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown error");
                vec![AgentEvent::Failed {
                    message: format!("Codex failed: {message}"),
                }]
            }
            (_, ItemPhase::Started(_)) => {
                let title = codex_item_title(kind, value);
                self.open_items.insert(id, title.clone());
                vec![AgentEvent::ActivityStart { title }]
            }
            (_, ItemPhase::Completed(_)) => {
                let mut events = Vec::new();
                if self.open_items.remove(&id).is_some() {
                    // Paired with a started item: flip its title to the past
                    // tense, land the detail inside the block, close it.
                    if let Some(title) = codex_item_done_title(kind, value) {
                        events.push(AgentEvent::ActivityRetitle { title });
                    }
                    let detail = codex_item_detail(kind, value);
                    if !detail.is_empty() {
                        events.push(AgentEvent::ActivityAppend { detail });
                    }
                    events.push(AgentEvent::ActivityEnd);
                }
                events
            }
        }
    }
}

/// One-line activity title per codex item kind, while the item runs.
fn codex_item_title(kind: &str, item: &serde_json::Value) -> String {
    match kind {
        "command_execution" => format!(
            "Running $ {}",
            short_title(
                item.get("command").and_then(serde_json::Value::as_str).unwrap_or("command"),
                72
            )
        ),
        "reasoning" => "Reasoning".to_string(),
        "file_change" => format!(
            "{} {}",
            file_change_verb(item),
            codex_first_path(item)
        ),
        "mcp_tool_call" => format!(
            "Calling {}",
            item.get("tool").and_then(serde_json::Value::as_str).unwrap_or("mcp")
        ),
        "web_search" => format!(
            "Searching {}",
            short_title(
                item.get("query").and_then(serde_json::Value::as_str).unwrap_or(""),
                60
            )
        ),
        other => short_title(other, 40),
    }
}

/// The past-tense title once the item completed: "Ran $ …", "Wrote file.rs".
fn codex_item_done_title(kind: &str, item: &serde_json::Value) -> Option<String> {
    match kind {
        "command_execution" => Some(format!(
            "Ran $ {}",
            short_title(
                item.get("command").and_then(serde_json::Value::as_str).unwrap_or("command"),
                72
            )
        )),
        "file_change" => Some(format!("{} {}", file_change_verb(item), codex_first_path(item))),
        "mcp_tool_call" => Some(format!(
            "Called {}",
            item.get("tool").and_then(serde_json::Value::as_str).unwrap_or("mcp")
        )),
        "web_search" => Some(format!(
            "Searched {}",
            short_title(
                item.get("query").and_then(serde_json::Value::as_str).unwrap_or(""),
                60
            )
        )),
        // Reasoning keeps its title; it renders as plain text anyway.
        _ => None,
    }
}

/// First changed path of a codex file_change item.
fn codex_first_path(item: &serde_json::Value) -> String {
    let path = item
        .get("changes")
        .and_then(serde_json::Value::as_array)
        .and_then(|changes| changes.first())
        .and_then(|change| change.get("path"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("files");
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Wrote / Edited / Deleted, from the first change kind of the item.
fn file_change_verb(item: &serde_json::Value) -> &'static str {
    let kind = item
        .get("changes")
        .and_then(serde_json::Value::as_array)
        .and_then(|changes| changes.first())
        .and_then(|change| change.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("update");
    match kind {
        "add" => "Wrote",
        "delete" => "Deleted",
        _ => "Edited",
    }
}

/// Expanded detail for a completed codex item.
fn codex_item_detail(kind: &str, item: &serde_json::Value) -> String {
    match kind {
        "command_execution" => {
            let output = item
                .get("aggregated_output")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let exit = item
                .get("exit_code")
                .and_then(serde_json::Value::as_i64);
            let mut detail = String::new();
            if !output.is_empty() {
                detail.push_str(&capped(output, MAX_ACTIVITY_DETAIL - 32));
            }
            if let Some(code) = exit.filter(|code| *code != 0) {
                if !detail.is_empty() {
                    detail.push_str("\n\n");
                }
                detail.push_str(&format!("exit code: {code}"));
            }
            detail
        }
        "reasoning" => {
            // Codex streams reasoning either as `text` or as a `summary`
            // array of {type, text} parts — take whichever carries words.
            let text = item
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !text.trim().is_empty() {
                return text.to_string();
            }
            item.get("summary")
                .and_then(serde_json::Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default()
        }
        "file_change" => item
            .get("changes")
            .and_then(serde_json::Value::as_array)
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|change| {
                        let path = change.get("path").and_then(serde_json::Value::as_str)?;
                        let kind = change.get("kind").and_then(serde_json::Value::as_str)?;
                        Some(format!("{kind} {path}"))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => serde_json::to_string(item).unwrap_or_default(),
    }
}
