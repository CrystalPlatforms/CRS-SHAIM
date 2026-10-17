//! AgentRunner integration tests.
//!
//! Assumptions these tests encode:
//! - Fixtures are REAL recordings, not invented shapes: `claude-stream.jsonl`
//!   is a headless run of Claude Code 2.1.299 (`-p --output-format
//!   stream-json --verbose --include-partial-messages --permission-mode
//!   acceptEdits` on a scratch folder); `codex-stream.jsonl` is a headless
//!   run of codex-cli 0.162.1 (`exec --json --skip-git-repo-check --sandbox
//!   workspace-write`). Headless flags drift between CLI versions — adapters
//!   are isolated so a drifted fixture only ever means re-recording.
//! - A recorded fixture parses through the exact `AgentRunner::run` path a
//!   live session uses (spawn → read lines → adapter parse → fold): the
//!   test adapter spawns `/bin/sh cat <fixture>` and delegates parsing to
//!   the real adapter.
//! - Claude Code with partial messages streams `stream_event` lines and
//!   tool results in `user` lines; complete `assistant` lines are duplicates
//!   and must not double the text.
//! - Codex emits `item.started`/`item.completed` pairs; `agent_message`
//!   items are the replies and arrive completed-only.
//! - Text folds into assistant-message segments, tool/thinking/command
//!   activity into collapsible activity segments, in stream order.
//! - Stop kills the spawned child process; the run only returns after the
//!   child's exit has been observed (`wait`), with `aborted = true`.
//! - A missing CLI binary is a structured `AgentError::MissingBinary`
//!   naming the binary, the label and install guidance — never a crash.
//!
//! The "process" in the termination test is `/bin/sh sleep <marker>` — no
//! real agent CLI is needed to prove the kill.

use std::path::{Path, PathBuf};
use std::time::Duration;

use shaim_lib::agent::{
    adapter_for, AgentAccess, AgentAdapter, AgentError, AgentEvent, AgentRunner, Segment,
};
use shaim_lib::gateway::AbortFlag;
use shaim_lib::store::AgentKind;

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// Spawns `sh -c 'cat <fixture>'` and parses its stdout with the REAL
/// adapter — recorded lines ride through the live run path.
struct FixtureRunner {
    inner: Box<dyn AgentAdapter>,
    fixture: PathBuf,
}

impl AgentAdapter for FixtureRunner {
    fn label(&self) -> &'static str {
        self.inner.label()
    }

    fn binary(&self) -> &'static str {
        self.inner.binary()
    }

    fn install_hint(&self) -> &'static str {
        self.inner.install_hint()
    }

    fn build_command(
        &self,
        _cwd: &Path,
        _prompt: &str,
        _access: AgentAccess,
        _model: Option<&str>,
        _images: &[std::path::PathBuf],
    ) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("cat \"$1\"")
            .arg("sh")
            .arg(&self.fixture);
        command
    }

    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        self.inner.parse_line(line)
    }
}

/// A stand-in agent that just sleeps — the kill target of the Stop test.
/// The marker rides in the shell's argv so `pgrep -f` can prove its death.
struct SleeperAdapter {
    marker: &'static str,
}

impl AgentAdapter for SleeperAdapter {
    fn label(&self) -> &'static str {
        "Sleeper"
    }

    fn binary(&self) -> &'static str {
        "sh"
    }

    fn install_hint(&self) -> &'static str {
        ""
    }

    fn build_command(
        &self,
        _cwd: &Path,
        _prompt: &str,
        _access: AgentAccess,
        _model: Option<&str>,
        _images: &[std::path::PathBuf],
    ) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg(format!("sleep 30 # {}", self.marker));
        command
    }

    fn parse_line(&mut self, _line: &str) -> Vec<AgentEvent> {
        Vec::new()
    }
}

/// An adapter whose binary never exists — the missing-CLI path.
struct MissingAdapter;

impl AgentAdapter for MissingAdapter {
    fn label(&self) -> &'static str {
        "Missing CLI"
    }

    fn binary(&self) -> &'static str {
        "shaim-nonexistent-cli-for-tests"
    }

    fn install_hint(&self) -> &'static str {
        "imagine install instructions here"
    }

    fn build_command(
        &self,
        _cwd: &Path,
        _prompt: &str,
        _access: AgentAccess,
        _model: Option<&str>,
        _images: &[std::path::PathBuf],
    ) -> tokio::process::Command {
        tokio::process::Command::new(self.binary())
    }

    fn parse_line(&mut self, _line: &str) -> Vec<AgentEvent> {
        Vec::new()
    }
}

fn scratch_dir() -> PathBuf {
    std::env::temp_dir()
}

#[tokio::test]
async fn claude_fixture_parses_into_messages_and_activity_blocks() {
    let mut adapter = FixtureRunner {
        inner: adapter_for(AgentKind::ClaudeCode),
        fixture: fixture_path("claude-stream.jsonl"),
    };
    let mut events = Vec::new();
    let outcome = AgentRunner::run(
        &mut adapter,
        &scratch_dir(),
        "create hello.txt",
        AgentAccess::Full,
        None,
        &[],
        &AbortFlag::new(),
        |event| events.push(event),
    )
    .await
    .expect("fixture run should succeed");

    assert!(outcome.error.is_none(), "no agent-reported failure");
    assert!(!outcome.aborted);

    // Activity blocks exist and carry the real tool/thinking names.
    let started: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ActivityStart { title } => Some(title.as_str()),
            _ => None,
        })
        .collect();
    assert!(started.contains(&"Thinking"), "thinking block: {started:?}");
    assert!(started.contains(&"Write"), "tool block named by the CLI: {started:?}");

    // Every started block closes, and the Write block received its input
    // JSON plus the tool result appended by the `user` line.
    let ends = events
        .iter()
        .filter(|event| matches!(event, AgentEvent::ActivityEnd))
        .count();
    assert_eq!(ends, started.len(), "every activity block closes");
    let write_appends: Vec<&String> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ActivityAppend { detail } if detail.contains("file_path") => {
                Some(detail)
            }
            _ => None,
        })
        .collect();
    assert!(
        !write_appends.is_empty(),
        "tool input JSON lands in the block detail"
    );
    let result_appends: Vec<&String> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ActivityAppend { detail } if detail.starts_with("\n\n→ ") => {
                Some(detail)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        result_appends.len(),
        1,
        "exactly one tool result arrives, capped and marked: {result_appends:?}"
    );

    // Folded segments: thinking activity → tool activity → final text.
    assert_eq!(
        outcome.segments.len(),
        3,
        "thinking, tool and one reply, in stream order: {:?}",
        outcome.segments
    );
    match &outcome.segments[0] {
        Segment::Activity { title, detail } => {
            assert_eq!(title, "Thinking");
            assert!(
                detail.starts_with("The user wants me to create a file named hello.txt"),
                "thinking detail opens with the recorded reasoning: {detail:?}"
            );
        }
        other => panic!("expected activity segment, got {other:?}"),
    }
    match &outcome.segments[1] {
        Segment::Activity { title, detail } => {
            // The Write tool reads as "Running hello.txt" while it works and
            // "Wrote hello.txt" once its result landed — with the raw input
            // JSON plus the tool result in the detail.
            assert_eq!(title, "Wrote hello.txt");
            assert!(detail.contains("hello.txt"), "input in detail: {detail:?}");
            assert!(detail.contains("→"), "tool result appended: {detail:?}");
        }
        other => panic!("expected activity segment, got {other:?}"),
    }
    match &outcome.segments[2] {
        Segment::Text(text) => assert!(text.contains("gotowe"), "reply text: {text:?}"),
        other => panic!("expected text segment, got {other:?}"),
    }
}

#[tokio::test]
async fn codex_fixture_parses_through_the_same_runner_path() {
    let mut adapter = FixtureRunner {
        inner: adapter_for(AgentKind::Codex),
        fixture: fixture_path("codex-stream.jsonl"),
    };
    let mut events = Vec::new();
    let outcome = AgentRunner::run(
        &mut adapter,
        &scratch_dir(),
        "create hello.txt",
        AgentAccess::Full,
        None,
        &[],
        &AbortFlag::new(),
        |event| events.push(event),
    )
    .await
    .expect("fixture run should succeed");

    assert!(outcome.error.is_none());
    assert!(!outcome.aborted);

    // The command execution became an activity block titled by the command.
    let started: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ActivityStart { title } => Some(title.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(started.len(), 1, "one command run: {started:?}");
    assert!(
        started[0].starts_with("Running $ /bin/zsh -lc"),
        "the command reads as running: {started:?}"
    );

    // Segments fold in stream order: the command run, then the reply.
    assert_eq!(outcome.segments.len(), 2, "{:?}", outcome.segments);
    match &outcome.segments[0] {
        Segment::Activity { title, detail } => {
            assert!(
                title.starts_with("Ran $ /bin/zsh -lc"),
                "completion flips to the past tense: {title:?}"
            );
            // Output was empty and exit code 0 — detail stays empty.
            assert_eq!(detail, "");
        }
        other => panic!("expected activity segment, got {other:?}"),
    }
    assert_eq!(outcome.segments[1], Segment::Text("done".into()));
}

#[tokio::test]
async fn stop_terminates_the_spawned_process() {
    const MARKER: &str = "shaim-agent-kill-test";
    let mut adapter = SleeperAdapter { marker: MARKER };
    let abort = AbortFlag::new();

    // Stop fires while the sleeper is running; the runner must kill the
    // child and only return once its exit has been observed.
    let stop = abort.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.abort();
    });

    let outcome = AgentRunner::run(
        &mut adapter,
        &scratch_dir(),
        "sleep",
        AgentAccess::Full,
        None,
        &[],
        &abort,
        |_event| {},
    )
    .await
    .expect("killed run still returns an outcome");

    assert!(outcome.aborted, "the run reports the abort");
    assert!(outcome.segments.is_empty(), "nothing streamed before the kill");
    assert!(outcome.error.is_none(), "a user-initiated Stop is not an error");

    // The child is really gone: nothing matches the marker anymore.
    let alive = std::process::Command::new("pgrep")
        .arg("-f")
        .arg(MARKER)
        .output()
        .expect("pgrep should run");
    assert!(
        !alive.status.success(),
        "sleeper process should be dead after Stop"
    );
}

// ---- Skills handoff (issue #19) ---------------------------------------------

/// Records the exact prompt the runner hands to `build_command` — the same
/// handoff a real CLI receives — and exits immediately.
struct PromptSpy {
    captured: std::sync::Arc<std::sync::Mutex<String>>,
}

impl AgentAdapter for PromptSpy {
    fn label(&self) -> &'static str {
        "PromptSpy"
    }

    fn binary(&self) -> &'static str {
        "sh"
    }

    fn install_hint(&self) -> &'static str {
        ""
    }

    fn build_command(
        &self,
        _cwd: &Path,
        prompt: &str,
        _access: AgentAccess,
        _model: Option<&str>,
        _images: &[PathBuf],
    ) -> tokio::process::Command {
        *self
            .captured
            .lock()
            .expect("spy lock") = prompt.to_string();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.arg("-c").arg("true");
        command
    }

    fn parse_line(&mut self, _line: &str) -> Vec<AgentEvent> {
        Vec::new()
    }
}

#[tokio::test]
async fn enabled_skills_reach_the_agent_handoff_and_disabled_do_not() {
    use shaim_lib::skills::{prompt_block, SkillStore};
    use shaim_lib::store::Store;

    let dir = std::env::temp_dir().join(format!(
        "shaim-agent-skills-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should be creatable");
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
    let skills = SkillStore::open(&dir.join("skills")).expect("library should open");

    // The composition send_agent_message performs: the enabled block (plus a
    // one-shot, none here) prepended to the prompt the CLI receives.
    let import = |name: &str, body: &str| {
        let source = dir.join(format!("{name}.md"));
        std::fs::write(&source, format!("---\nname: {name}\n---\n\n{body}"))
            .expect("fixture should write");
        skills.import(&store, &source).expect("import should succeed").id
    };
    let enabled = import("formatter", "Format every output as a table.");
    let disabled = import("censor", "Never mention the deadline.");
    skills.set_enabled(&store, enabled, true).expect("enable");
    skills.set_enabled(&store, disabled, false).expect("disable");

    let block = prompt_block(&skills.enabled_prompts(&store).expect("prompts"));
    let prompt = shaim_lib::agent::prompt_with_skills("Fix the failing test.", &block);

    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let mut adapter = PromptSpy {
        captured: captured.clone(),
    };
    AgentRunner::run(
        &mut adapter,
        &scratch_dir(),
        &prompt,
        AgentAccess::ReadOnly,
        None,
        &[],
        &AbortFlag::new(),
        |_event| {},
    )
    .await
    .expect("spy run should complete");

    let handed_off = captured.lock().expect("spy lock").clone();
    assert!(
        handed_off.contains("## Active skills")
            && handed_off.contains("### formatter")
            && handed_off.contains("Format every output as a table."),
        "enabled skills ride in the prompt the adapter hands to the CLI"
    );
    assert!(
        !handed_off.contains("deadline"),
        "disabled skills never reach the handoff"
    );
    assert!(
        handed_off.ends_with("Fix the failing test."),
        "the user's message stays last, after the skills block"
    );
}

#[tokio::test]
async fn missing_binary_returns_a_structured_error() {
    let mut adapter = MissingAdapter;
    let error = AgentRunner::run(
        &mut adapter,
        &scratch_dir(),
        "anything",
        AgentAccess::Full,
        None,
        &[],
        &AbortFlag::new(),
        |_event| {},
    )
    .await
    .expect_err("a missing binary must fail the run");

    match &error {
        AgentError::MissingBinary {
            binary,
            label,
            install_hint,
        } => {
            assert_eq!(binary, "shaim-nonexistent-cli-for-tests");
            assert_eq!(*label, "Missing CLI");
            assert_eq!(*install_hint, "imagine install instructions here");
            // The message itself carries the guidance for the UI error box.
            let message = error.to_string();
            assert!(message.contains("Missing CLI"), "{message}");
            assert!(message.contains("imagine install instructions"), "{message}");
        }
        other => panic!("expected MissingBinary, got {other:?}"),
    }
}

#[test]
fn cli_model_detection_lists_real_models() {
    let codex = shaim_lib::commands::list_cli_models("codex".into()).unwrap();
    println!("codex models: {codex:?}");
    assert!(
        codex.contains(&"gpt-5.6-terra".to_string())
            && codex.contains(&"gpt-5.6-luna".to_string()),
        "session history models must be detected: {codex:?}"
    );
    let claude = shaim_lib::commands::list_cli_models("claude_code".into()).unwrap();
    println!("claude models: {claude:?}");
    assert!(claude.contains(&"default".to_string()));
}
