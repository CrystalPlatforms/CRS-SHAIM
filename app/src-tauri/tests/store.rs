//! Store integration tests.
//!
//! Assumptions these tests encode:
//! - A fresh `Store::open` on a nonexistent path is "first launch": it must
//!   create the file, the four entity tables, and the FTS5 virtual table.
//! - Timestamps are unix seconds; ordering is `updated_at DESC, id DESC`.
//! - Deleting a conversation cascades to its messages (schema property).
//! - "Restart" is simulated by dropping the `Store` and reopening the same
//!   file — the app process itself is not spawned.
//!
//! Not covered in this iteration: FTS5 *query* behavior (search ships in a
//! later phase; here we only assert the virtual table exists), servers and
//! settings CRUD (no Store API yet), concurrency across threads.

use std::path::PathBuf;

use shaim_lib::store::Store;

/// Unique per-test temp dir; cleared before the run so leftovers never
/// interfere.
fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shaim-tests-{}-{}",
        std::process::id(),
        name
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("shaim.db")
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
