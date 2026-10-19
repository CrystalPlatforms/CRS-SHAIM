//! Permission rules and the Claude control protocol (issue #28).
//!
//! Assumptions these tests encode:
//! - A standing rule matches EXACTLY: the stored pattern is what the ask
//!   showed, so only the identical command / path / tool name passes.
//! - File rules tolerate the two spellings of one path (`./x` vs `x`,
//!   relative vs absolute-for-the-same-cwd) but nothing fuzzier.
//! - Rules are conversation-scoped (`conversation_id`) or global (`NULL`);
//!   the effective set for a conversation is global ∪ own, and deleting a
//!   conversation deletes its scoped rules by FK cascade.
//! - `control_response_line` speaks the exact wire shape the installed CLI
//!   answers (allow carries `updatedInput`, deny carries a message) —
//!   verified against claude 2.1.303 with `--permission-prompt-tool stdio`.

use std::path::Path;

use shaim_lib::agent::{control_response_line, permission_target};
use shaim_lib::commands::{auto_allowed, rule_matches, same_path};
use shaim_lib::store::{AllowedKind, Store};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("shaim-perm-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir should create");
    dir
}

fn rule(kind: AllowedKind, pattern: &str) -> shaim_lib::store::AllowedRule {
    shaim_lib::store::AllowedRule {
        id: 0,
        conversation_id: None,
        kind: kind.as_str().to_string(),
        pattern: pattern.to_string(),
        created_at: 0,
    }
}

#[test]
fn command_rules_match_bash_exactly() {
    let r = rule(AllowedKind::Command, "npm test");
    assert!(rule_matches(&r, "Bash", "npm test"));
    assert!(rule_matches(&r, "run_command", "npm test"));
    // A longer command is a DIFFERENT command — no prefix matching.
    assert!(!rule_matches(&r, "Bash", "npm test --watch"));
    assert!(!rule_matches(&r, "Bash", "npm  test"), "whitespace is part of the command");
    // A command rule never covers a different tool.
    assert!(!rule_matches(&r, "Write", "npm test"));
}

#[test]
fn file_rules_match_both_spellings_of_one_path() {
    let r = rule(AllowedKind::File, "src/app.rs");
    assert!(rule_matches(&r, "Edit", "src/app.rs"));
    assert!(rule_matches(&r, "Write", "./src/app.rs"));
    assert!(same_path("src/app.rs", "./src/app.rs"));
    // A different file is a different permission.
    assert!(!rule_matches(&r, "Edit", "src/other.rs"));
    assert!(!same_path("src/app.rs", "src/other.rs"));
    // File rules never cover commands.
    assert!(!rule_matches(&r, "Bash", "src/app.rs"));
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
    let store = Store::open(&dir.join("shaim.db")).expect("store should open");
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
