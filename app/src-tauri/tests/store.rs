//! Store integration tests.
//!
//! Assumptions these tests encode:
//! - A fresh `Store::open` on a nonexistent path is "first launch": it must
//!   create the file, the four entity tables, and the FTS5 virtual table.
//! - Timestamps are unix seconds; ordering is `updated_at DESC, id DESC`.
//! - Deleting a conversation cascades to its messages (schema property).
//! - Deleting a *server* must never take conversations with it: the link is
//!   nulled (`ON DELETE SET NULL`) and the conversation stays openable.
//! - Auto-title fires only while the title is still the schema default, so it
//!   is set exactly once and never overrides a manual rename.
//! - "Restart" is simulated by dropping the `Store` and reopening the same
//!   file — the app process itself is not spawned.
//!
//! Not covered in this iteration: FTS5 *query* behavior (search ships in a
//! later phase; here we only assert the virtual table exists), concurrency
//! across threads.

use std::path::PathBuf;

use klepai_lib::store::Store;

/// Unique per-test temp dir; cleared before the run so leftovers never
/// interfere.
fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "klepai-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("klepai.db")
}

#[test]
fn first_launch_creates_schema_with_entity_tables_and_fts5() {
    let db = temp_db("first-launch");
    let store = Store::open(&db).expect("first launch should create the database");

    let tables = store.table_names().expect("table_names should succeed");
    for expected in [
        "servers",
        "conversations",
        "messages",
        "settings",
        "messages_fts", // FTS5 virtual table created successfully
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "expected table `{expected}` after first launch, got: {tables:?}"
        );
    }

    // Reopening the same file is idempotent — no duplicate-schema errors.
    drop(store);
    let reopened = Store::open(&db).expect("second open should not fail");
    assert_eq!(reopened.table_names().unwrap().len(), tables.len());
}

#[test]
fn conversation_create_rename_delete_round_trip() {
    let db = temp_db("crud");
    let store = Store::open(&db).unwrap();

    // Create — one with the schema default title, one named.
    let auto = store.create_conversation(None).unwrap();
    assert_eq!(auto.title, "New conversation");
    let named = store.create_conversation(Some("Linux box chat")).unwrap();
    assert_eq!(named.title, "Linux box chat");

    // List — newest first (created_at ordering via updated_at/id DESC).
    let listed = store.list_conversations().unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, named.id);
    assert_eq!(listed[1].id, auto.id);

    // Rename — visible on the next read, ordering moves it to the top.
    store.rename_conversation(auto.id, "Renamed").unwrap();
    let listed = store.list_conversations().unwrap();
    assert_eq!(listed.len(), 2);
    let renamed = listed.iter().find(|c| c.id == auto.id).unwrap();
    assert_eq!(renamed.title, "Renamed");

    // Delete — the other conversation survives.
    store.delete_conversation(auto.id).unwrap();
    let listed = store.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, named.id);
    assert_eq!(listed[0].title, "Linux box chat");

    // Boundary: mutating a missing conversation is an error, not a silent no-op.
    assert!(store.rename_conversation(auto.id, "ghost").is_err());
    assert!(store.delete_conversation(auto.id).is_err());
}

#[test]
fn deleting_a_conversation_removes_its_messages() {
    let db = temp_db("cascade");
    let store = Store::open(&db).unwrap();

    let conversation = store.create_conversation(Some("to be deleted")).unwrap();
    store.insert_message(conversation.id, "user", "hello").unwrap();
    store.insert_message(conversation.id, "assistant", "hi there").unwrap();
    assert_eq!(store.message_ids(conversation.id).unwrap().len(), 2);

    store.delete_conversation(conversation.id).unwrap();
    assert!(
        store.message_ids(conversation.id).unwrap().is_empty(),
        "messages must be removed together with their conversation"
    );

    // Boundary: messages cannot dangle on a nonexistent conversation.
    let other = store.create_conversation(None).unwrap();
    assert!(store.insert_message(999_999, "user", "x").is_err());
    assert_eq!(store.message_ids(other.id).unwrap().len(), 0);
}

#[test]
fn data_survives_a_simulated_restart() {
    let db = temp_db("restart");

    // "First app run": create data, then quit (drop the Store).
    let title;
    {
        let store = Store::open(&db).unwrap();
        let conversation = store.create_conversation(Some("persists across runs")).unwrap();
        store
            .insert_message(conversation.id, "user", "remember me")
            .unwrap();
        title = conversation.title;
    } // Store closed here — like quitting the app.

    // "Second app run": everything is still there, with its name.
    let store = Store::open(&db).unwrap();
    let listed = store.list_conversations().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, title);

    let ids = store.message_ids(listed[0].id).unwrap();
    assert_eq!(ids.len(), 1, "messages must survive a restart too");
}

// ---- Servers ----------------------------------------------------------------

#[test]
fn server_crud_round_trip() {
    let store = Store::open(&temp_db("server-crud")).unwrap();

    let ollama = store
        .create_server("Linux box", "ollama", "http://192.168.1.10:11434", None)
        .unwrap();
    assert_eq!(ollama.name, "Linux box");
    assert_eq!(ollama.kind, "ollama");
    assert_eq!(ollama.api_key, None);

    let keyed = store
        .create_server(
            "Router relay",
            "openai_compatible",
            "http://192.168.1.20:8080",
            Some("sk-abc"),
        )
        .unwrap();
    assert_eq!(keyed.api_key.as_deref(), Some("sk-abc"));

    let listed = store.list_servers().unwrap();
    assert_eq!(listed.len(), 2);

    // Unknown kinds are rejected by the schema CHECK, not silently stored.
    assert!(store
        .create_server("Broken", "lmstudio", "http://x", None)
        .is_err());

    store
        .update_server(ollama.id, "Renamed box", "ollama", "http://192.168.1.11:11434", None)
        .unwrap();
    let reloaded = store.get_server(ollama.id).unwrap();
    assert_eq!(reloaded.name, "Renamed box");
    assert_eq!(reloaded.base_url, "http://192.168.1.11:11434");

    // Editing clears the key when told to.
    store
        .update_server(keyed.id, keyed.name.as_str(), keyed.kind.as_str(), keyed.base_url.as_str(), None)
        .unwrap();
    assert_eq!(store.get_server(keyed.id).unwrap().api_key, None);

    store.delete_server(ollama.id).unwrap();
    assert!(store.get_server(ollama.id).is_err());
    assert!(store.delete_server(ollama.id).is_err(), "deleting a missing server is an error");
}

#[test]
fn deleting_a_server_keeps_past_conversations_openable() {
    let store = Store::open(&temp_db("server-delete")).unwrap();

    let server = store
        .create_server(" doomed", "ollama", "http://10.0.0.5:11434", None)
        .unwrap();
    let conversation = store.create_conversation(Some("chat with the box")).unwrap();
    store
        .set_conversation_model(conversation.id, Some(server.id), Some("llama3:8b"))
        .unwrap();
    store.insert_message(conversation.id, "user", "hello box").unwrap();

    store.delete_server(server.id).unwrap();

    // The conversation survives with its messages; only the link is gone.
    let reloaded = store.get_conversation(conversation.id).unwrap();
    assert_eq!(reloaded.title, "chat with the box");
    assert_eq!(reloaded.server_id, None, "server link must be cleared, not dangling");
    assert_eq!(store.message_ids(conversation.id).unwrap().len(), 1);
    assert!(store.list_conversations().unwrap().iter().any(|c| c.id == conversation.id));
}

#[test]
fn conversation_model_pinning_round_trip() {
    let store = Store::open(&temp_db("model-pin")).unwrap();

    let conversation = store.create_conversation(None).unwrap();
    assert_eq!(conversation.server_id, None);
    assert_eq!(conversation.model_id, None);

    let server = store
        .create_server("box", "ollama", "http://10.0.0.5:11434", None)
        .unwrap();
    store
        .set_conversation_model(conversation.id, Some(server.id), Some("qwen2.5:7b"))
        .unwrap();
    let pinned = store.get_conversation(conversation.id).unwrap();
    assert_eq!(pinned.server_id, Some(server.id));
    assert_eq!(pinned.model_id.as_deref(), Some("qwen2.5:7b"));

    // Back to defaults: both cleared.
    store.set_conversation_model(conversation.id, None, None).unwrap();
    let cleared = store.get_conversation(conversation.id).unwrap();
    assert_eq!(cleared.server_id, None);
    assert_eq!(cleared.model_id, None);

    // FK: pinning to a nonexistent server is refused.
    assert!(store
        .set_conversation_model(conversation.id, Some(999_999), Some("x"))
        .is_err());
    assert!(store.set_conversation_model(999_999, None, None).is_err());
}

// ---- Auto-title ----------------------------------------------------------------

#[test]
fn autotitle_sets_once_and_respects_manual_rename() {
    let store = Store::open(&temp_db("autotitle")).unwrap();

    let conversation = store.create_conversation(None).unwrap();
    assert_eq!(conversation.title, "New conversation");

    let changed = store
        .maybe_autotitle(conversation.id, "Explain how async runtimes schedule tasks in Rust please")
        .unwrap();
    assert!(changed, "first message must set the title");
    let titled = store.get_conversation(conversation.id).unwrap();
    assert!(titled.title.starts_with("Explain how async"));
    assert!(titled.title.ends_with('…'), "long titles truncate with an ellipsis");
    assert!(titled.title.chars().count() <= 48, "title must stay short");

    // A later message must not re-title.
    let changed = store
        .maybe_autotitle(conversation.id, "completely different topic")
        .unwrap();
    assert!(!changed);
    assert_eq!(
        store.get_conversation(conversation.id).unwrap().title,
        titled.title,
        "title is set exactly once"
    );

    // …and a manual rename wins over any later auto-title attempt.
    store.rename_conversation(conversation.id, "My own name").unwrap();
    store
        .maybe_autotitle(conversation.id, "another attempt")
        .unwrap();
    assert_eq!(store.get_conversation(conversation.id).unwrap().title, "My own name");

    // A short first line is used verbatim.
    let other = store.create_conversation(None).unwrap();
    store.maybe_autotitle(other.id, "quick question\nwith a second line").unwrap();
    assert_eq!(store.get_conversation(other.id).unwrap().title, "quick question");
}

// ---- Message payload round-trip --------------------------------------------------

#[test]
fn messages_round_trip_with_thinking_and_images() {
    let store = Store::open(&temp_db("message-full")).unwrap();

    let conversation = store.create_conversation(None).unwrap();
    let images = vec![
        "data:image/png;base64,QUJDREVG".to_string(),
        "data:image/jpeg;base64,MTIzNDU2".to_string(),
    ];
    let message = store
        .insert_message_full(
            conversation.id,
            "assistant",
            "Here is what I see.",
            Some("The user attached two images; I looked at both."),
            &images,
            None,
        )
        .unwrap();

    assert_eq!(message.images, images, "images must round-trip unchanged");

    let loaded = store.list_messages(conversation.id).unwrap();
    assert_eq!(loaded.len(), 1);
    let loaded = &loaded[0];
    assert_eq!(loaded.id, message.id);
    assert_eq!(loaded.role, "assistant");
    assert_eq!(loaded.content, "Here is what I see.");
    assert_eq!(
        loaded.thinking.as_deref(),
        Some("The user attached two images; I looked at both."),
        "thinking must round-trip"
    );
    assert_eq!(loaded.images, images, "images must round-trip unchanged");

    // Partial content (an aborted stream) persists like any other message.
    let partial = store
        .insert_message_full(conversation.id, "assistant", "partial answ", None, &[], None)
        .unwrap();
    let loaded = store.list_messages(conversation.id).unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[1].content, "partial answ");
    assert_eq!(loaded[1].thinking, None);
    assert!(loaded[1].images.is_empty());
    assert_eq!(loaded[1].id, partial.id);
}

// ---- Settings ---------------------------------------------------------------------

#[test]
fn settings_defaults_round_trip() {
    let store = Store::open(&temp_db("settings")).unwrap();

    // Never configured: defaults are empty, not an error.
    let settings = store.get_settings().unwrap();
    assert_eq!(settings.default_server_id, None);
    assert_eq!(settings.default_model_id, None);

    let server = store
        .create_server("box", "ollama", "http://10.0.0.5:11434", None)
        .unwrap();
    store
        .set_default_model(Some(server.id), Some("llama3:8b"))
        .unwrap();
    let settings = store.get_settings().unwrap();
    assert_eq!(settings.default_server_id, Some(server.id));
    assert_eq!(settings.default_model_id.as_deref(), Some("llama3:8b"));

    // Overwrite, then clear — the single row is upserted, never duplicated.
    store.set_default_model(Some(server.id), Some("qwen2.5:7b")).unwrap();
    assert_eq!(
        store.get_settings().unwrap().default_model_id.as_deref(),
        Some("qwen2.5:7b")
    );
    store.set_default_model(None, None).unwrap();
    let settings = store.get_settings().unwrap();
    assert_eq!(settings.default_server_id, None);
    assert_eq!(settings.default_model_id, None);
}
