//! Permission rules and the Claude control protocol (issues #28, #32).
//!
//! Assumptions these tests encode:
//! - A remembered rule is GENERAL (issue #32), not exact: "allow permanently"
//!   / "allow for this conversation" stores the command's PROGRAM SEQUENCE
//!   (`cd frontend && npm run build` → `cd && npm`) or the file ACTION
//!   (`create` / `edit`), and every later ask with the same sequence / action
//!   passes without asking. Plain "Allow" still stores nothing.
//! - Command patterns split on `&&`/`||`/`;`/`|` and keep each segment's
//!   first whitespace token. Quotes are not parsed — an operator inside a
//!   quoted string splits anyway (worst case: an extra ask, never a grant
//!   wider than the sequence that was shown). Env-prefix assignments are
//!   kept as the program token (`FOO=1 npm …` → `FOO=1`), not special-cased.
//! - Pre-#32 rules are not migrated: an old full-command pattern derives its
//!   own sequence (so `npm test` now grants the whole `npm` family — the
//!   widening #32 asks for), and an old file path pattern matches nothing.
//! - There is no delete-file tool; deletion rides Bash, so it is covered by
//!   command rules (`rm …` → the `rm` family).
//! - Rules are conversation-scoped (`conversation_id`) or global (`NULL`);
//!   the effective set for a conversation is global ∪ own, and deleting a
//!   conversation deletes its scoped rules by FK cascade.
//! - `control_response_line` speaks the exact wire shape the installed CLI
//!   answers (allow carries `updatedInput`, deny carries a message) —
//!   verified against claude 2.1.303 with `--permission-prompt-tool stdio`.

use std::path::Path;

use klepai_lib::agent::{control_response_line, permission_target};
use klepai_lib::commands::{auto_allowed, rule_matches, rule_pattern_for};
use klepai_lib::store::{AllowedKind, Store};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("klepai-perm-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should create");
    dir
}

fn rule(kind: AllowedKind, pattern: &str) -> klepai_lib::store::AllowedRule {
    klepai_lib::store::AllowedRule {
        id: 0,
        conversation_id: None,
        kind: kind.as_str().to_string(),
        pattern: pattern.to_string(),
        created_at: 0,
    }
}

#[test]
fn remembered_patterns_store_the_general_form() {
    // Commands remember the program sequence, not the exact line (#32).
    assert_eq!(rule_pattern_for("Bash", "npm run build"), "npm");
    assert_eq!(
        rule_pattern_for("Bash", "cd frontend && npm run build"),
        "cd && npm"
    );
    assert_eq!(rule_pattern_for("Bash", "cat notes.txt | grep todo"), "cat && grep");
    // Files remember the action, not the path (#32): Write creates,
    // Edit/MultiEdit/NotebookEdit edit.
    assert_eq!(rule_pattern_for("Write", "src/app.rs"), "create");
    assert_eq!(rule_pattern_for("Edit", "src/app.rs"), "edit");
    assert_eq!(rule_pattern_for("NotebookEdit", "nb.ipynb"), "edit");
    // Tools already remember the whole tool.
    assert_eq!(rule_pattern_for("WebFetch", "https://example.com"), "WebFetch");
}

#[test]
fn command_rule_covers_any_command_with_the_same_programs() {
    let r = rule(AllowedKind::Command, "npm");
    assert!(rule_matches(&r, "Bash", "npm install"));
    assert!(rule_matches(&r, "Bash", "npm run dev"));
    assert!(rule_matches(&r, "run_command", "npm ci"));
    // A different program family is a different permission.
    assert!(!rule_matches(&r, "Bash", "git status"));
    // A command rule never covers a different tool.
    assert!(!rule_matches(&r, "Write", "npm test"));
}

#[test]
fn command_rules_match_by_program_family() {
    // A pre-#32 exact pattern derives its own family: `npm test` reads as
    // `npm` and widens to every npm command (issue #32).
    let r = rule(AllowedKind::Command, "npm test");
    assert!(rule_matches(&r, "Bash", "npm test"));
    assert!(rule_matches(&r, "run_command", "npm test"));
    assert!(rule_matches(&r, "Bash", "npm test --watch"));
    assert!(rule_matches(&r, "Bash", "npm  test"), "whitespace is not part of the family");
    // A different program family is a different permission.
    assert!(!rule_matches(&r, "Bash", "git status"));
    // A command rule never covers a different tool.
    assert!(!rule_matches(&r, "Write", "npm test"));
}

#[test]
fn file_rules_match_by_action_not_path() {
    let create = rule(AllowedKind::File, "create");
    // Any path, any spelling — the grant is the action, not the file (#32).
    assert!(rule_matches(&create, "Write", "src/app.rs"));
    assert!(rule_matches(&create, "Write", "./totally/other.txt"));
    assert!(rule_matches(&create, "write_file", "docs/readme.md"));
    // Creating does not grant editing.
    assert!(!rule_matches(&create, "Edit", "src/app.rs"));

    let edit = rule(AllowedKind::File, "edit");
    assert!(rule_matches(&edit, "Edit", "src/app.rs"));
    assert!(rule_matches(&edit, "MultiEdit", "other.rs"));
    assert!(rule_matches(&edit, "NotebookEdit", "nb.ipynb"));
    // Editing does not grant creating.
    assert!(!rule_matches(&edit, "Write", "new.rs"));

    // Pre-#32 path patterns derive no action — they match nothing (left
    // unmigrated by decision).
    assert!(!rule_matches(&rule(AllowedKind::File, "src/app.rs"), "Write", "src/app.rs"));
    // File rules never cover commands.
    assert!(!rule_matches(&create, "Bash", "src/app.rs"));
}

#[test]
fn tool_rules_cover_a_whole_tool() {
    let r = rule(AllowedKind::Tool, "WebFetch");
    assert!(rule_matches(&r, "WebFetch", "https://example.com"));
    assert!(!rule_matches(&r, "WebSearch", "https://example.com"));
}

#[test]
fn auto_allowed_needs_only_one_matching_rule() {
    let rules = vec![rule(AllowedKind::Command, "ls"), rule(AllowedKind::Tool, "WebFetch")];
    assert!(auto_allowed(&rules, "Bash", "ls"));
    assert!(auto_allowed(&rules, "WebFetch", "anything"));
    assert!(!auto_allowed(&rules, "Bash", "rm -rf /"));
}

#[test]
fn target_prefers_command_then_paths_then_falls_back_to_the_tool() {
    let input = r#"{"command":"git status","file_path":"ignored.rs"}"#;
    assert_eq!(permission_target("Bash", input), "git status");
    let file_input = r#"{"file_path":"src/main.rs","content":"…"}"#;
    assert_eq!(permission_target("Write", file_input), "src/main.rs");
    assert_eq!(permission_target("WebFetch", "{}"), "WebFetch");
    assert_eq!(permission_target("Bash", "not json"), "Bash");
}

#[test]
fn control_response_line_carries_the_wire_shape() {
    let allow = control_response_line("req-1", true, r#"{"command":"ls"}"#);
    let allow: serde_json::Value = serde_json::from_str(&allow).expect("valid json");
    assert_eq!(allow["type"], "control_response");
    assert_eq!(allow["response"]["subtype"], "success");
    assert_eq!(allow["response"]["request_id"], "req-1");
    assert_eq!(allow["response"]["response"]["behavior"], "allow");
    assert_eq!(allow["response"]["response"]["updatedInput"]["command"], "ls");

    let deny = control_response_line("req-2", false, "{}");
    let deny: serde_json::Value = serde_json::from_str(&deny).expect("valid json");
    assert_eq!(deny["response"]["response"]["behavior"], "deny");
    assert!(deny["response"]["response"]["message"]
        .as_str()
        .expect("deny carries a message")
        .len()
        > 0);
}

#[test]
fn rules_scope_globally_per_conversation_and_cascade() {
    let dir = temp_dir("scope");
    let store = Store::open(&dir.join("klepai.db")).expect("store should open");
    let conv = store.create_conversation(None).expect("create").id;
    let other = store.create_conversation(None).expect("create").id;

    let global = store
        .add_allowed_rule(None, AllowedKind::Command, "git status")
        .expect("global rule should save");
    let scoped = store
        .add_allowed_rule(Some(conv), AllowedKind::Command, "npm test")
        .expect("scoped rule should save");

    // Settings → Allowed lists ONLY the global rule.
    let listed = store.list_global_allowed_rules().expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, global.id);
    assert_eq!(listed[0].pattern, "git status");

    // The effective set: global ∪ own — and nothing of another chat's.
    let mine = store
        .rules_for_conversation(conv)
        .expect("rules for conv");
    assert_eq!(mine.len(), 2);
    let theirs = store
        .rules_for_conversation(other)
        .expect("rules for other conv");
    assert_eq!(theirs.len(), 1, "another conversation sees only the global rule");

    // Deleting the conversation takes its scoped rule with it (FK cascade);
    // the global rule survives.
    store.delete_conversation(conv).expect("delete");
    let left = store.list_global_allowed_rules().expect("list");
    assert_eq!(left.len(), 1, "global rules outlive conversations");
    assert!(
        store
            .rules_for_conversation(other)
            .expect("rules")
            .iter()
            .all(|rule| rule.id != scoped.id),
        "the scoped rule is gone with its conversation"
    );

    // Removing one rule by id works and reports unknown ids.
    store
        .delete_allowed_rule(global.id)
        .expect("delete should work");
    assert!(store.list_global_allowed_rules().expect("list").is_empty());
    assert!(
        store.delete_allowed_rule(global.id).is_err(),
        "deleting a gone rule is an error"
    );
    let _ = Path::new(&dir);
}
