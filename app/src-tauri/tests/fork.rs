//! Fork from this (issue #9).
//!
//! Assumptions these tests encode:
//! - Forking copies exactly the selected message and everything after it
//!   into a brand-new conversation; nothing before is cloned; the original
//!   conversation is byte-identical afterwards (same rows, same content).
//! - The fork inherits the conversation-level settings (server/model pin
//!   included) and takes a sane title from the message it starts at.
//! - Forking is one INSERT..SELECT, so a 1 000-message conversation forks
//!   well under 100 ms.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use klepai_lib::store::Store;

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "klepai-fork-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("klepai.db")
}

fn open(name: &str) -> Store {
    Store::open(&temp_db(name)).expect("store should open")
}

/// Seeds `count` alternating user/assistant messages and returns their ids
/// in conversation order.
fn seed_thread(store: &Store, conversation_id: i64, count: usize) -> Vec<i64> {
    (0..count)
        .map(|index| {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store
                .insert_message(conversation_id, role, &format!("message {index:04}"))
                .unwrap()
        })
        .collect()
}

// ---- Fork semantics ----------------------------------------------------------

#[test]
fn fork_copies_exactly_from_the_selected_message_onward() {
    let store = open("fork-semantics");
    let conv = store.create_conversation(None).unwrap();
    let ids = seed_thread(&store, conv.id, 10);

    // Fork from message 5 of 10: the new thread starts there.
    let fork = store.fork_conversation(conv.id, ids[5]).unwrap();
    assert_ne!(fork.id, conv.id);

    let forked = store.list_messages(fork.id).unwrap();
    assert_eq!(forked.len(), 5, "messages 5..=9 only — nothing before");
    assert_eq!(forked[0].content, "message 0005");
    assert_eq!(forked[4].content, "message 0009");
    // Roles and attachments travel with the copy. (Index 5 is odd, so the
    // fork starts on an assistant message.)
    let roles: Vec<&str> = forked.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(roles, vec!["assistant", "user", "assistant", "user", "assistant"]);

    // New rows, not shared ones: fresh ids in the fork.
    assert_ne!(forked[0].id, ids[5]);

    // Nothing before is cloned: message 4 is nowhere in the fork.
    assert!(
        !forked.iter().any(|m| m.content == "message 0004"),
        "the fork must not contain anything before the selected message"
    );

    // The original is untouched: still 10 messages, same order and content.
    let original = store.list_messages(conv.id).unwrap();
    assert_eq!(original.len(), 10);
    for (index, message) in original.iter().enumerate() {
        assert_eq!(message.id, ids[index]);
        assert_eq!(message.content, format!("message {index:04}"));
    }
}

#[test]
fn fork_inherits_settings_and_takes_a_sane_title() {
    let store = open("fork-settings");
    let server = store
        .create_server("box", "ollama", "http://127.0.0.1:11434", None)
        .unwrap();
    let conv = store.create_conversation(None).unwrap();
    store
        .set_conversation_model(conv.id, Some(server.id), Some("llama3:8b"))
        .unwrap();
    store
        .set_conversation_settings(conv.id, Some("Be terse."), Some(0.5), Some(1024))
        .unwrap();
    store.rename_conversation(conv.id, "Original name").unwrap();

    let start = store
        .insert_message(conv.id, "user", "Tell me about otters")
        .unwrap();
    store.insert_message(conv.id, "assistant", "Otters are neat.").unwrap();

    let fork = store.fork_conversation(conv.id, start).unwrap();
    assert_eq!(fork.title, "Tell me about otters", "title from the message it starts at");
    assert_eq!(fork.server_id, Some(server.id), "server pin inherited");
    assert_eq!(fork.model_id.as_deref(), Some("llama3:8b"), "model pin inherited");
    assert_eq!(fork.system_prompt.as_deref(), Some("Be terse."));
    assert_eq!(fork.temperature, Some(0.5));
    assert_eq!(fork.context_len, Some(1024));
    // Reasoning is always on app-wide — nothing per-row to inherit.
}

#[test]
fn fork_rejects_a_message_from_another_conversation() {
    let store = open("fork-validation");
    let conv_a = store.create_conversation(None).unwrap();
    let conv_b = store.create_conversation(None).unwrap();
    let intruder = store
        .insert_message(conv_b.id, "user", "not from A")
        .unwrap();

    let result = store.fork_conversation(conv_a.id, intruder);
    assert!(result.is_err(), "forking across conversations must fail");
}

#[test]
fn fork_of_a_1000_message_conversation_completes_under_100ms() {
    let store = open("fork-performance");
    let conv = store.create_conversation(None).unwrap();
    let ids = seed_thread(&store, conv.id, 1000);

    let start = Instant::now();
    let fork = store.fork_conversation(conv.id, ids[500]).unwrap();
    let elapsed = start.elapsed();

    assert!(
        elapsed < Duration::from_millis(100),
        "forking 1 000 messages took {elapsed:?}, budget is 100 ms"
    );
    assert_eq!(store.list_messages(fork.id).unwrap().len(), 500);
    assert_eq!(store.list_messages(conv.id).unwrap().len(), 1000);
}
